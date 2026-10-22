import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { createTransport } from 'nodemailer';
import { Document, DocumentStatus } from '../entities/document.entity';
import { User } from '../entities/user.entity';
import { DestructionRequest, DestructionItem, DestructionJob, DestructionApproval, destructionEntities } from '../entities/destruction.entity';
import { DestructionWorkflow1792368000000, DESTRUCTION_REQUIRED_TRIGGERS } from '../migrations/1792368000000-DestructionWorkflow';
import { Actor, approvalsValid, digest, eligible, fail, staff } from './destruction.rules';
import { distinctRoots, hashFile, inside, LocalDestructionJournal, relativeKey, safePath, walk } from './local-storage';
import { WindowsDefenderScanner } from './windows-defender-scanner';
import { inspectDestructionContent } from './content-integrity';

const execute = promisify(execFile);
interface Target { key: string; label: string; root: string; purgeWithinDays: number; notes: string; versioning: string; authoritative: boolean; enabled?: boolean }
interface Settings { version: string; inventoryScope: string; targets: Target[]; policyTargets: Target[]; archive: string; state: string; staging: string }
const keyIdentity = (key: string) => process.platform === 'win32' ? key.toLowerCase() : key;
const sameBackupKey = (actual: string, expected: string) => keyIdentity(actual) === keyIdentity(expected) || keyIdentity(actual).endsWith(`/${keyIdentity(expected)}`);

/** Direct provider for authoritative filesystem/UNC/mounted storage. No separate HTTP service required. */
@Injectable()
export class LocalDestructionInfrastructure implements OnModuleDestroy {
  private journalInstance?: LocalDestructionJournal;
  private readonly lockContext = new AsyncLocalStorage<boolean>();
  private healthCache?: { expires: number; value: any };
  private healthInFlight?: Promise<any>;
  constructor(private readonly config: ConfigService, private readonly db: DataSource) {}

  settings(): Settings {
    const filename = this.config.get<string>('DESTRUCTION_LOCAL_CONFIG');
    if (!filename) fail(503, 'LOCAL_CONFIG_REQUIRED', 'Chưa cấu hình DESTRUCTION_LOCAL_CONFIG cho hủy hồ sơ trực tiếp.');
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (typeof raw.version !== 'string' || !raw.version.trim() || raw.version.startsWith('REPLACE_') || raw.inventoryScope !== 'database-files-only'
      || !Array.isArray(raw.targets) || raw.targets.length !== 3
      || !['external', 'cloud', 'nas'].every(key => raw.targets.some(t => t.key === key)))
      fail(503, 'INVALID_BACKUP_POLICY', 'Chính sách phải có version và đủ ba đích backup.');
    for (const target of raw.targets) {
      if (target.enabled === false) {
        if (target.root || target.purgeWithinDays !== 0 || !target.label || !target.notes?.trim())
          fail(503, 'INVALID_UNUSED_TARGET', `${target.key}: kho không sử dụng phải có enabled=false, root rỗng, purgeWithinDays=0 và notes giải thích.`);
        continue;
      }
      if (!target.root || target.root.startsWith('REPLACE_'))
        fail(503, 'BACKUP_ROOT_REQUIRED', `${target.key}: điền root là đường dẫn thư mục backup riêng đã tồn tại, không phải thư mục file gốc.`);
      if (!Number.isSafeInteger(target.purgeWithinDays) || target.purgeWithinDays < 1)
        fail(503, 'BACKUP_RETENTION_REQUIRED', `${target.key}: purgeWithinDays phải là số ngày theo chính sách đã phê duyệt.`);
      if (!target.root || !target.label || !Number.isSafeInteger(target.purgeWithinDays) || target.purgeWithinDays < 1
        || !Number.isFinite(new Date(Date.now() + target.purgeWithinDays * 86400000).getTime())
        || target.versioning !== 'none' || target.authoritative !== true)
        fail(503, 'UNSUPPORTED_BACKUP_TARGET', `${target.key}: cần xác nhận authoritative=true và versioning=none cho kho thực tế không có version/snapshot ẩn.`);
    }
    if (!raw.targets.some(t => t.enabled !== false)) fail(503, 'BACKUP_REQUIRED', 'Cần ít nhất một kho backup riêng được quản lý. Ổ chứa file gốc và SQL không thay thế kho backup.');
    const archive = fs.realpathSync(this.config.get<string>('UPLOAD_ARCHIVE_DIR') || './storage/archive');
    const state = fs.realpathSync(this.config.get<string>('DESTRUCTION_STATE_DIR') || './storage/destruction-state');
    const staging = fs.realpathSync(this.config.get<string>('DESTRUCTION_BACKUP_STAGING_ROOT') || './storage/destruction-backup-staging');
    const targets = raw.targets.filter(t => t.enabled !== false).map(t => ({ ...t, root: fs.realpathSync(t.root) }));
    if (process.platform === 'win32' && state.startsWith('\\\\'))
      fail(503, 'LOCAL_JOURNAL_REQUIRED', 'SQLite WAL cần nằm trên ổ local của server, không đặt trên UNC/NAS.');
    const otherRoots = [this.config.get<string>('UPLOAD_STAGING_DIR') || './storage/staging',
      this.config.get<string>('PERSONAL_STORAGE_DIR') || './storage/personal'].map(p => fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
    distinctRoots([archive, state, staging, ...targets.map(t => t.root), ...otherRoots]);
    return { ...raw, archive, state, staging, targets, policyTargets: raw.targets };
  }
  private verifyBackupCoverage(s: Settings) {
    if ((this.config.get<string>('RCLONE_REMOTES') || '').trim() || (this.config.get<string>('BACKUP_TARGETS') || '').trim())
      fail(503, 'UNMANAGED_REMOTE_BACKUP', 'Đang có đích rclone ngoài bộ quản lý filesystem. Chuyển các đích sang kho được hỗ trợ hoặc dùng gateway quản lý version của provider.');
    const paths = [this.config.get<string>('BACKUP_DIR') || './storage/backup',
      ...(this.config.get<string>('BACKUP_LOCAL_TARGETS') || '').split(';').filter(Boolean)];
    for (const backup of paths) {
      const resolved = fs.existsSync(backup) ? fs.realpathSync(backup) : path.resolve(backup);
      if (!s.targets.some(target => inside(target.root, resolved, true)))
        fail(503, 'UNMANAGED_LOCAL_BACKUP', 'BACKUP_DIR hoặc BACKUP_LOCAL_TARGETS nằm ngoài các kho backup đang sử dụng đã khai báo.');
    }
  }
  private journal() {
    const settings = this.settings();
    if (!this.journalInstance) this.journalInstance = new LocalDestructionJournal(settings.state);
    if (this.journalInstance.directory !== settings.state) fail(503, 'STATE_DIRECTORY_CHANGED', 'Thư mục nhật ký đã thay đổi; cần khởi động lại backend.');
    const identity = this.journalInstance.get('identity', 'deployment');
    if (identity && digest(identity.targets) !== digest(Object.fromEntries(settings.targets.map(t => [t.key, t.root]))))
      fail(503, 'TARGET_SET_CHANGED', 'Các kho đã khởi tạo đã thay đổi. Không được đánh dấu kho cũ là không sử dụng để bỏ qua backup/tombstone; cần di chuyển có kiểm soát.');
    return this.journalInstance;
  }
  onModuleDestroy() { this.journalInstance?.close(); }
  initializeStorage() {
    const s = this.settings(), journal = this.journal();
    let identity = journal.get('identity', 'deployment');
    if (!identity) {
      if (s.targets.some(t => fs.existsSync(path.join(t.root, '.lths-destruction-target.json'))))
        fail(409, 'JOURNAL_IDENTITY_MISSING', 'Đã có marker backup nhưng thiếu định danh nhật ký. Phải phục hồi nhật ký cũ trước.');
      identity = { id: randomUUID(), archive: s.archive, targets: Object.fromEntries(s.targets.map(t => [t.key, t.root])) };
      journal.put('identity', 'deployment', identity);
    }
    for (const target of s.targets) {
      const filename = path.join(target.root, '.lths-destruction-target.json');
      if (fs.existsSync(filename)) {
        const prior = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (prior.key !== target.key || prior.policyVersion !== s.version || prior.journalId !== identity.id)
          fail(409, 'TARGET_IDENTITY_CHANGED', 'Marker kho khác policy/nhật ký. Cần kiểm tra và di chuyển cấu hình có kiểm soát.');
      } else fs.writeFileSync(filename, JSON.stringify({ key: target.key, policyVersion: s.version, journalId: identity.id }), { flag: 'wx', mode: 0o600 });
    }
  }
  private verifyTarget(target: Target, s: Settings) {
    const identity = this.journal().get('identity', 'deployment');
    const marker = JSON.parse(fs.readFileSync(path.join(target.root, '.lths-destruction-target.json'), 'utf8'));
    if (!identity || identity.archive !== s.archive || identity.targets?.[target.key] !== target.root
      || marker.key !== target.key || marker.policyVersion !== s.version || marker.journalId !== identity.id)
      fail(503, 'BACKUP_IDENTITY_UNCONFIRMED', 'Không xác nhận được kho backup và nhật ký gốc. Chạy kiểm tra hoặc phục hồi nhật ký.');
  }
  maintenance(): boolean {
    const directory = this.config.get<string>('DESTRUCTION_STATE_DIR') || './storage/destruction-state';
    return fs.existsSync(path.join(directory, 'maintenance.json'));
  }
  sessions() {
    return this.journal().all('session').map(({ id, operation, status, verified }) => ({ id, operation, status, verified: verified === true }));
  }
  async exportJournal(filename: string) {
    const s = this.settings();
    const resolved = path.resolve(filename);
    if (!path.isAbsolute(filename) || !resolved.endsWith('.sqlite') || fs.existsSync(resolved)
      || [s.archive, s.staging, ...s.targets.map(t => t.root)].some(root => inside(root, resolved, true)))
      fail(422, 'UNSAFE_JOURNAL_BACKUP', 'Chọn file .sqlite mới trong vùng backup nhật ký được bảo vệ riêng.');
    fs.accessSync(path.dirname(resolved), fs.constants.W_OK);
    await this.exclusive(async () => { this.journal().backup(resolved); });
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore()) return operation();
    const runner = this.db.createQueryRunner();
    const name = `lths-destruction-${digest(String(this.db.options.database)).slice(0, 24)}`;
    await runner.connect();
    try {
      const [result] = await runner.query('SELECT GET_LOCK(?, 30) AS acquired', [name]);
      if (Number(result.acquired) !== 1) fail(409, 'STORAGE_BUSY', 'Kho đang được sao lưu hoặc xử lý. Vui lòng thử lại.');
      return await this.lockContext.run(true, operation);
    } finally {
      try { await runner.query('SELECT RELEASE_LOCK(?)', [name]); } finally { await runner.release(); }
    }
  }
  private mailer() {
    const host = this.config.get<string>('SMTP_HOST'), user = this.config.get<string>('SMTP_USER'), pass = this.config.get<string>('SMTP_PASS');
    if (!host || !user || !pass || !this.config.get('SMTP_FROM')) fail(503, 'SMTP_REQUIRED', 'Chưa cấu hình SMTP để gửi OTP hủy hồ sơ.');
    return createTransport({ host, port: Number(this.config.get('SMTP_PORT') || 587), secure: this.config.get('SMTP_SECURE') === 'true',
      auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      requireTLS: this.config.get('SMTP_SECURE') !== 'true', logger: false, debug: false });
  }
  private scanner(): string {
    const provider = this.config.get<string>('DESTRUCTION_SCANNER') || 'clamav';
    if (!['clamav', 'defender'].includes(provider)) fail(503, 'INVALID_SCANNER', 'DESTRUCTION_SCANNER phải là clamav hoặc defender.');
    return provider;
  }
  private defender() { return new WindowsDefenderScanner(this.config); }
  private async command(args: string[]) {
    const executable = this.config.get<string>('DESTRUCTION_SCANNER_PATH');
    if (!executable || !path.isAbsolute(executable)) fail(503, 'SCANNER_REQUIRED', 'Chưa cấu hình đường dẫn tuyệt đối đến ClamAV clamscan.');
    return execute(executable, args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  }
  async diagnostics() {
    const reasons: string[] = [];
    let storage: Settings | undefined;
    try { storage = this.settings(); this.journal(); } catch (e) {
      reasons.push(e.code === 'ERR_UNKNOWN_BUILTIN_MODULE' ? 'Chế độ local cần Node.js 22.13 trở lên có node:sqlite.'
        : e.getResponse?.()?.message || 'Thiếu hoặc sai chính sách, đường dẫn kho, nhật ký hoặc staging.');
    }
    const secret = this.config.get<string>('DESTRUCTION_OTP_SECRET') || this.config.get<string>('JWT_SECRET');
    if (!secret || secret.length < 32) reasons.push('DESTRUCTION_OTP_SECRET cần ít nhất 32 ký tự.');
    await Promise.all([
      (async () => {
        try { await this.mailer().verify(); } catch { reasons.push('SMTP chưa xác thực hoặc không kết nối được.'); }
      })(),
      (async () => {
        try {
          if (this.scanner() === 'defender') await this.defender().ready();
          else await this.command(['--version']);
          if (storage && !(await this.scanPdf({ bytes: Buffer.from('LTHS scanner readiness probe').toString('base64') })).clean)
            throw new Error('scanner database or scan unavailable');
        } catch (e) {
          reasons.push(e.getResponse?.()?.message || (this.config.get('DESTRUCTION_SCANNER') === 'defender'
            ? 'Microsoft Defender chưa sẵn sàng: kiểm tra trạng thái, dữ liệu nhận diện virus và quyền chạy MpCmdRun của tài khoản backend.'
            : 'ClamAV clamscan hoặc cơ sở dữ liệu virus chưa sẵn sàng.'));
        }
      })(),
      (async () => {
        try {
          const [packet] = await this.db.manager.query('SELECT @@max_allowed_packet AS bytes');
          if (Number(packet.bytes) < 64 * 1024 * 1024) reasons.push(`MySQL max_allowed_packet hiện ${Number(packet.bytes) / 1048576} MiB; cần ít nhất 64 MiB.`);
          const triggers = await this.db.manager.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');
          const missing = DESTRUCTION_REQUIRED_TRIGGERS.filter(name => !triggers.some(t => t.TRIGGER_NAME === name));
          if (missing.length) reasons.push(`Thiếu trigger: ${missing.join(', ')}. Sau khi backup DB, chạy npm run db:repair-destruction.`);
        } catch { reasons.push('Không thể kiểm tra schema và cấu hình MySQL.'); }
      })(),
    ]);
    if (storage) try {
      const s = storage;
      this.verifyBackupCoverage(s);
      for (const root of [s.state, s.staging, ...s.targets.map(t => t.root)]) {
        const probe = path.join(root, `.lths-probe-${randomUUID()}`);
        try {
          fs.writeFileSync(probe, 'LTHS readiness', { flag: 'wx', mode: 0o600 });
          if (fs.readFileSync(probe, 'utf8') !== 'LTHS readiness') throw new Error('probe mismatch');
        } finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); }
      }
      for (const target of s.targets) this.verifyTarget(target, s);
    } catch (e) { reasons.push(e.getResponse?.()?.message || 'Chưa xác nhận các đích backup hoặc không thể truy cập kho. Chạy destruction:init sau khi cấu hình đúng.'); }
    if (this.maintenance()) reasons.push('Hệ thống đang bảo trì để khôi phục backup.');
    return [...new Set(reasons)];
  }
  private async health() {
    if (this.maintenance()) return { ready: false };
    if (this.healthCache && this.healthCache.expires > Date.now()) return this.healthCache.value;
    // The page and worker may ask together. Share the same probes within this process.
    if (!this.healthInFlight) {
      this.healthInFlight = this.checkHealth().finally(() => { this.healthInFlight = undefined; });
    }
    return this.healthInFlight;
  }
  private async checkHealth() {
    const reasons = await this.diagnostics();
    if (this.maintenance()) return { ready: false };
    if (reasons.length) {
      const value = { ready: false, reasons };
      this.healthCache = { expires: Date.now() + 10000, value };
      return value;
    }
    const s = this.settings();
    const value = { ready: true, otp: true, worker: true, immutableEvidence: true, malwareScanner: true,
      contentInventory: true, backupExclusion: true, restoreTombstones: true,
      backupPolicy: { version: s.version, targets: s.policyTargets.map(({ key, label, purgeWithinDays, notes, enabled }) => ({ key, label, purgeWithinDays, notes: notes || '', ...(enabled === false ? { enabled: false } : {}) })) } };
    this.healthCache = { expires: Date.now() + 30000, value };
    return value;
  }
  async readinessReasons(): Promise<string[]> {
    const health = await this.health();
    return health.reasons || (health.ready ? [] : ['Hệ thống đang bảo trì để khôi phục backup.']);
  }
  async call(operation: string, payload: any): Promise<any> {
    if (operation === 'health') return this.health();
    if (operation === 'scan-pdf') return this.scanPdf(payload);
    return this.exclusive(async () => {
      if (this.maintenance() && !operation.startsWith('restore/')) fail(503, 'MAINTENANCE', 'Hệ thống đang khôi phục dữ liệu.');
      switch (operation) {
        case 'otp/deliver': return this.deliverOtp(payload);
        case 'content/inventory': return this.inventory(payload);
        case 'content/destroy': return this.destroy(payload);
        case 'backup/exclude': return this.exclude(payload);
        case 'backup/purge': return this.purge(payload);
        case 'backup/begin': return this.beginBackup(payload);
        case 'backup/end': return this.endBackup(payload);
        case 'restore/begin': return this.beginRestore(payload);
        case 'restore/apply-tombstones': return this.applyRestore(payload);
        case 'restore/end': return this.endRestore(payload);
        case 'restore/cancel-preparing': return this.cancelPreparingRestore(payload);
        default: fail(422, 'UNKNOWN_OPERATION', 'Thao tác hạ tầng không hợp lệ.');
      }
    });
  }
  private async scanPdf(payload: any) {
    if (this.maintenance()) fail(503, 'MAINTENANCE', 'Hệ thống đang khôi phục dữ liệu.');
    const temp = await fs.promises.mkdtemp(path.join(this.settings().state, 'scan-'));
    const filename = path.join(temp, 'attachment.pdf');
    try {
      const bytes = Buffer.from(payload.bytes, 'base64');
      await fs.promises.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      if (this.scanner() === 'defender') await this.defender().scan(filename);
      else await this.command(['--no-summary', filename]);
      if (!(await fs.promises.readFile(filename)).equals(bytes)) throw new Error('Scanned content changed');
      return { clean: true, readable: true };
    } catch { return { clean: false, readable: false }; }
    finally { await fs.promises.unlink(filename).catch(() => {}); await fs.promises.rmdir(temp).catch(() => {}); }
  }
  private async deliverOtp(payload: any) {
    const actor = await this.db.manager.findOne(User, { where: { id: payload.actorId }, relations: ['department'] });
    if (!actor?.isActive || !staff({ id: actor.id, role: actor.role, departmentId: actor.department?.id }) || !actor.email || !/^\d{6,8}$/.test(payload.otp)
      || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now())
      fail(422, 'OTP_DELIVERY_INVALID', 'Không thể gửi OTP cho tài khoản này.');
    const result = await this.mailer().sendMail({ from: this.config.get<string>('SMTP_FROM'), to: actor.email,
      subject: 'Xác nhận phê duyệt hủy hồ sơ LTHS',
      text: `Mã OTP phê duyệt hủy hồ sơ: ${payload.otp}\nMã hết hạn lúc ${payload.expiresAt}. Không chia sẻ mã này.` });
    return { delivered: result.accepted?.some(address => String(address).toLowerCase() === actor.email.toLowerCase()) === true };
  }
  /** Read-only ownership report for operators; does not initialize or change the journal. */
  async inspectOwnership(documentId: string, filename: string) {
    // Windows file IDs can exceed Number's integer precision. Compare the exact IDs.
    const expected = await fs.promises.stat(filename, { bigint: true });
    // Separate queries also support legacy tables with different UUID/path collations.
    const groups = await Promise.all([
      this.db.manager.query('SELECT d.id AS documentId,d.status,d.storage_path AS filename FROM documents d LIMIT 100001'),
      this.db.manager.query('SELECT d.id AS documentId,d.status,f.storage_key AS filename FROM documents d JOIN files f ON f.id=d.file_id LIMIT 100001'),
      this.db.manager.query('SELECT v.document_id AS documentId,d.status,v.storage_path AS filename FROM document_versions v JOIN documents d ON d.id=v.document_id LIMIT 100001'),
      this.db.manager.query("SELECT p.id AS documentId,'personal' AS status,p.storage_path AS filename FROM personal_files p LIMIT 100001"),
    ]);
    const owners = groups.flat();
    if (owners.length > 100000) fail(409, 'OWNERSHIP_SCAN_LIMIT', 'Kho cần bộ kiểm kê sở hữu có chỉ mục trước khi hủy.');
    const references = new Map<string, { id: string; status: string }>();
    for (const owner of owners) {
      if ((owner.documentId === documentId && owner.status !== 'personal') || owner.status === 'destroyed' || !owner.filename) continue;
      try {
        const stat = await fs.promises.stat(path.resolve(owner.filename), { bigint: true });
        if (fs.realpathSync(owner.filename) === fs.realpathSync(filename) || (stat.ino !== 0n && stat.ino === expected.ino && stat.dev === expected.dev))
          references.set(`${owner.status}:${owner.documentId}`, { id: owner.documentId, status: owner.status });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return { hardLinks: expected.nlink.toString(), references: [...references.values()] };
  }
  private async ownership(documentId: string, filename: string) {
    const report = await this.inspectOwnership(documentId, filename);
    if (report.hardLinks !== '1') fail(409, 'SHARED_CONTENT', 'File có hard link; không thể xác nhận sở hữu độc lập.');
    if (report.references.length) fail(409, 'SHARED_CONTENT', 'Nội dung còn được hồ sơ hoặc kho cá nhân khác sử dụng.');
  }
  private async currentDocument(payload: any) {
    const doc = await this.db.manager.findOne(Document, { where: { id: payload.documentId }, relations: ['file', 'documentType'] });
    const r = await this.db.manager.findOneBy(DestructionRequest, { id: payload.requestId });
    const job = await this.db.manager.findOneBy(DestructionJob, { requestId: payload.requestId });
    const [clock] = await this.db.manager.query('SELECT UTC_TIMESTAMP(3) AS now');
    const now = new Date(clock.now);
    if (!doc || !r || r.status !== 'processing' || !eligible(doc, now, r.id) || !doc.destructionStartedAt
      || !job || job.status !== 'processing' || !payload.leaseOwner || job.leaseOwner !== payload.leaseOwner || !job.leaseExpiry || job.leaseExpiry <= now)
      fail(409, 'DELETION_FENCE_FAILED', 'Worker hoặc điều kiện hủy không còn hợp lệ.');
    const approvals = await this.db.manager.findBy(DestructionApproval, { requestId: r.id });
    const docs = await this.db.manager.find(Document, { where: { destructionRequestId: r.id }, relations: ['department', 'uploader'] });
    const reviewers: Actor[] = [];
    for (const approval of approvals) {
      const actor = await this.db.manager.findOne(User, { where: { id: approval.userId }, relations: ['department'] });
      if (actor?.isActive) reviewers.push({ id: actor.id, role: actor.role, departmentId: actor.department?.id });
    }
    if (!approvalsValid(r, docs, approvals, reviewers))
      fail(409, 'APPROVAL_CHANGED', 'Lượt duyệt hoặc vai trò/khoa của người duyệt không còn hợp lệ.');
    return doc;
  }
  private async inventory(payload: any) {
    const doc = await this.currentDocument(payload), s = this.settings();
    const item = await this.db.manager.findOneBy(DestructionItem, { requestId: payload.requestId, documentId: doc.id });
    if (!item || digest(item.snapshot) !== digest(payload.snapshot) || doc.version !== item.snapshot.version || doc.sha256Checksum !== item.snapshot.checksum)
      fail(409, 'CONTENT_CHANGED', 'Snapshot nội dung đã thay đổi.');
    const versions = await this.db.manager.query('SELECT storage_path,sha256_checksum FROM document_versions WHERE document_id=? ORDER BY version', [doc.id]);
    const source = [{ storage_path: doc.file?.storageKey || doc.storagePath, sha256_checksum: doc.sha256Checksum },
      { storage_path: doc.storagePath, sha256_checksum: doc.sha256Checksum }, ...versions];
    const objects: any[] = [];
    for (const row of source) {
      const filename = safePath(s.archive, relativeKey(s.archive, row.storage_path));
      const key = relativeKey(s.archive, fs.realpathSync(filename));
      if (objects.some(object => object.key === key)) continue;
      await this.ownership(doc.id, filename);
      const sha256 = await hashFile(filename);
      // Snapshots bind plaintext; the deletion manifest binds the exact encrypted bytes.
      const { checksum: plaintextHash } = await inspectDestructionContent(filename, row.sha256_checksum);
      if (!/^[a-f0-9]{64}$/i.test(row.sha256_checksum || '') || plaintextHash !== row.sha256_checksum)
        fail(409, 'CONTENT_HASH_CHANGED', 'Checksum file hoặc phiên bản không khớp snapshot tin cậy.');
      objects.push({ key, sha256, sizeBytes: fs.statSync(filename).size });
    }
    const manifest = { id: randomUUID(), documentId: doc.id, requestId: payload.requestId, primaryChecksum: doc.sha256Checksum,
      contentVersion: doc.version, complete: true, safe: true, exclusiveOwnership: true, objects };
    this.journal().put('manifest', manifest.id, manifest);
    return manifest;
  }
  private async exclude(payload: any) {
    const s = this.settings(), journal = this.journal();
    if (!s.targets.some(t => t.key === payload.target) || payload.backupPolicy.version !== s.version)
      fail(409, 'BACKUP_POLICY_CHANGED', 'Đích hoặc chính sách backup đã thay đổi.');
    let trusted = false;
    for (const m of journal.iterate('manifest')) if (m.requestId === payload.requestId && m.documentId === payload.documentId && digest(m.objects) === digest(payload.objects)) { trusted = true; break; }
    if (!trusted)
      fail(409, 'TRUSTED_MANIFEST_REQUIRED', 'Tombstone phải tham chiếu manifest đã kiểm kê từ kho tin cậy.');
    const prior = journal.get('exclusion', payload.operationId);
    const binding = digest(payload);
    if (prior) { if (prior.binding !== binding) fail(409, 'EXCLUSION_CONFLICT', 'Tombstone đã có nội dung khác.'); return prior.receipt; }
    const receipt = { excluded: true, restoreProtected: true, evidenceId: randomUUID() };
    journal.put('exclusion', payload.operationId, { ...payload, binding, receipt, excludedAt: new Date().toISOString() });
    return receipt;
  }
  private async destroy(payload: any) {
    const s = this.settings(), journal = this.journal();
    const manifest = journal.get('manifest', payload.manifestId);
    if (!manifest || manifest.documentId !== payload.documentId || manifest.requestId !== payload.requestId || digest(manifest) !== payload.manifestDigest)
      fail(409, 'MANIFEST_CHANGED', 'Manifest hủy không hợp lệ.');
    const prior = journal.get('deletion', payload.operationId);
    if (prior) {
      if (prior.manifestId !== manifest.id || manifest.objects.some(o => fs.existsSync(safePath(s.archive, o.key, true))))
        fail(409, 'DELETION_REPLAY_CONFLICT', 'Nội dung xuất hiện lại hoặc manifest đã thay đổi.');
      return prior;
    }
    for (const target of s.targets) {
      const exclusion = journal.get('exclusion', digest([payload.requestId, payload.documentId, target.key]));
      if (!exclusion || digest(exclusion.objects) !== digest(manifest.objects)) fail(409, 'EXCLUSION_REQUIRED', 'Chưa ghi đủ tombstone cho các đích backup đang sử dụng.');
    }
    const receipts: any[] = [];
    for (const object of manifest.objects) {
      await this.currentDocument(payload);
      const id = digest([payload.operationId, object.key]), filename = safePath(s.archive, object.key, true);
      const checkpoint = journal.get('object', id);
      if (checkpoint && (checkpoint.manifestId !== manifest.id || checkpoint.sha256 !== object.sha256))
        fail(409, 'CHECKPOINT_CHANGED', 'Checkpoint không khớp manifest.');
      if (fs.existsSync(filename)) {
        if (checkpoint?.state === 'deleted') fail(409, 'CONTENT_REAPPEARED', 'Nội dung đã hủy xuất hiện lại.');
        await this.ownership(payload.documentId, filename);
        const stat = fs.statSync(filename), sha256 = await hashFile(filename);
        if (sha256 !== object.sha256) fail(409, 'CONTENT_HASH_CHANGED', 'Hash thay đổi ngay trước khi hủy.');
        journal.put('object', id, { state: 'intent', manifestId: manifest.id, sha256, size: stat.size, dev: stat.dev, ino: stat.ino });
        await this.currentDocument(payload);
        const checked = safePath(s.archive, object.key);
        const fresh = fs.statSync(checked);
        if (fresh.dev !== stat.dev || fresh.ino !== stat.ino || fresh.size !== stat.size || fresh.mtimeMs !== stat.mtimeMs || fresh.nlink !== 1)
          fail(409, 'CONTENT_CHANGED', 'Đối tượng file đã thay đổi trước khi xóa.');
        await fs.promises.unlink(checked);
      } else if (!checkpoint || !['intent', 'deleted'].includes(checkpoint.state)) {
        fail(409, 'MISSING_WITHOUT_CHECKPOINT', 'File mất nhưng chưa có checkpoint hủy hợp lệ.');
      }
      if (fs.existsSync(safePath(s.archive, object.key, true))) fail(503, 'DELETION_UNCONFIRMED', 'File vẫn tồn tại sau khi xóa.');
      const receipt = checkpoint?.receipt || { key: object.key, sha256: object.sha256, verifiedAbsent: true, evidenceId: randomUUID() };
      journal.put('object', id, { state: 'deleted', manifestId: manifest.id, sha256: object.sha256, receipt });
      receipts.push(receipt);
    }
    const receipt = { operationId: payload.operationId, manifestId: manifest.id, primaryChecksum: manifest.primaryChecksum,
      verifiedAbsent: true, evidenceId: randomUUID(), objects: receipts };
    journal.put('deletion', payload.operationId, receipt);
    return receipt;
  }
  private activeBackups() { return this.journal().all('session').some(s => s.operation === 'backup' && ['preparing', 'active'].includes(s.status)); }
  private async purge(payload: any) {
    const s = this.settings(), target = s.targets.find(t => t.key === payload.target), journal = this.journal();
    if (!target) fail(409, 'BACKUP_TARGET_CHANGED', 'Đích backup không còn được cấu hình.');
    if (this.activeBackups()) return { verifiedAbsent: false };
    this.verifyTarget(target, s);
    const tombstone = journal.get('exclusion', digest([payload.requestId, payload.documentId, target.key]));
    if (!tombstone || digest(tombstone.objects) !== digest(payload.objects)) fail(409, 'TOMBSTONE_REQUIRED', 'Chưa có tombstone tương ứng.');
    for await (const file of walk(target.root)) {
      const object = payload.objects.find(o => sameBackupKey(file.key, o.key));
      if (!object) continue;
      const stat = fs.statSync(file.filename);
      if (stat.nlink !== 1) fail(409, 'BACKUP_HARD_LINK', 'Backup có hard link ngoài vùng kiểm kê.');
      if (await hashFile(file.filename) !== object.sha256) fail(409, 'BACKUP_HASH_CHANGED', 'Nội dung backup không khớp manifest.');
      const id = digest([payload.operationId, file.key]);
      journal.put('purge-object', id, { state: 'intent', target: target.key, key: file.key, sha256: object.sha256 });
      const checked = safePath(target.root, file.key), fresh = fs.statSync(checked);
      if (fresh.dev !== stat.dev || fresh.ino !== stat.ino || fresh.size !== stat.size || fresh.mtimeMs !== stat.mtimeMs)
        fail(409, 'BACKUP_OBJECT_CHANGED', 'Đối tượng backup đã thay đổi trước khi xóa.');
      await fs.promises.unlink(checked);
      if (fs.existsSync(safePath(target.root, file.key, true))) fail(503, 'BACKUP_PURGE_UNCONFIRMED', 'Bản sao lưu chưa được xóa.');
      journal.put('purge-object', id, { state: 'deleted', target: target.key, key: file.key, sha256: object.sha256 });
    }
    // Verification enumerates the entire authoritative mirror, including timestamped backup subtrees.
    for await (const file of walk(target.root)) if (payload.objects.some(o => sameBackupKey(file.key, o.key)))
      return { verifiedAbsent: false };
    const receipt = { verifiedAbsent: true, evidenceId: randomUUID() };
    journal.put('purge', payload.operationId, receipt);
    return receipt;
  }
  private async beginBackup(payload: any) {
    const s = this.settings(), journal = this.journal();
    this.verifyBackupCoverage(s);
    for (const target of s.targets) this.verifyTarget(target, s);
    const id = randomUUID(), sourceDirectory = path.join(s.staging, id);
    const session = { id, operation: 'backup', status: 'preparing', sourceDirectory, operationId: payload.operationId };
    journal.put('session', id, session);
    try {
      await fs.promises.mkdir(sourceDirectory, { mode: 0o700 });
      const excluded = new Set<string>();
      for (const exclusion of journal.iterate('exclusion')) for (const object of exclusion.objects) excluded.add(keyIdentity(object.key));
      for await (const file of walk(s.archive)) {
        if (excluded.has(keyIdentity(file.key))) continue;
        const destination = path.join(sourceDirectory, ...file.key.split('/'));
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(file.filename, destination, fs.constants.COPYFILE_EXCL);
      }
      journal.put('session', id, { ...session, status: 'active' });
      return { sessionId: id, sourceDirectory, maintenanceProtected: true, exclusionsApplied: true, snapshotStable: true };
    } catch (e) { journal.put('session', id, { ...session, status: 'failed' }); throw e; }
  }
  private async endBackup(payload: any) {
    const journal = this.journal(), session = journal.get('session', payload.sessionId);
    if (!session || session.operation !== 'backup') fail(409, 'INVALID_BACKUP_SESSION', 'Phiên backup không hợp lệ.');
    const s = this.settings();
    if (!/^[a-f0-9-]{36}$/i.test(session.id) || session.sourceDirectory !== path.join(s.staging, session.id))
      fail(409, 'UNSAFE_BACKUP_SESSION', 'Thư mục snapshot không hợp lệ.');
    const root = safePath(s.staging, session.id, true);
    if (payload.success === true && session.status !== 'closed') {
      // Commit verified file generations to every active authoritative target.
      this.verifyBackupCoverage(s);
      for (const target of s.targets) {
        this.verifyTarget(target, s);
        const fileDigest = createHash('sha256');
        let filesCount = 0;
        for await (const file of walk(root)) {
          const key = `lths-managed/${session.id}/${file.key}`;
          const destination = safePath(target.root, key, true);
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          safePath(target.root, relativeKey(target.root, path.dirname(destination)));
          const checksum = await hashFile(file.filename);
          if (!fs.existsSync(destination)) await fs.promises.copyFile(file.filename, destination, fs.constants.COPYFILE_EXCL);
          if (await hashFile(safePath(target.root, key)) !== checksum)
            fail(503, 'BACKUP_COPY_UNCONFIRMED', 'Không xác nhận được checksum bản sao lưu.');
          fileDigest.update(digest([key, checksum])); filesCount++;
        }
        journal.put('backup-receipt', `${session.id}:${target.key}`, { sessionId: session.id, target: target.key,
          filesCount, filesDigest: fileDigest.digest('hex'), completedAt: new Date().toISOString(), evidenceId: randomUUID() });
      }
    }
    if (fs.existsSync(root)) {
      // Only this generated session's tree may be removed, after checking each child for symlinks/junctions.
      for await (const file of walk(root)) await fs.promises.unlink(safePath(root, file.key));
      const removeEmpty = async (directory: string) => {
        for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
          const relative = relativeKey(s.staging, path.join(directory, entry.name));
          const child = safePath(s.staging, relative);
          if (!entry.isDirectory()) fail(409, 'SNAPSHOT_CHANGED', 'Snapshot xuất hiện đối tượng ngoài kiểm kê.');
          await removeEmpty(child);
        }
        await fs.promises.rmdir(directory);
      };
      await removeEmpty(root);
    }
    journal.put('session', session.id, { ...session, status: 'closed', success: payload.success === true });
    return { closed: true };
  }
  private async beginRestore(payload: any) {
    const s = this.settings(), journal = this.journal();
    if (this.maintenance() || this.activeBackups() || await this.db.manager.countBy(DestructionJob, { status: 'processing' }))
      fail(409, 'RESTORE_BUSY', 'Cần dừng hoặc hoàn tất worker/backup trước khi khôi phục.');
    const id = randomUUID();
    fs.writeFileSync(path.join(s.state, 'maintenance.json'), JSON.stringify({ sessionId: id }), { flag: 'wx', mode: 0o600 });
    journal.put('session', id, { id, operation: 'restore', status: 'preparing', operationId: payload.operationId });
    // Preserve append-only evidence and all destruction history independently of the SQL dump being restored.
    for (const entity of destructionEntities) {
      const metadata = this.db.getMetadata(entity), table = metadata.tableName;
      let offset = 0;
      while (true) {
        const rows = await this.db.manager.query(`SELECT * FROM \`${table}\` ORDER BY \`${metadata.primaryColumns[0].databaseName}\` LIMIT 1 OFFSET ?`, [offset++]);
        if (!rows.length) break;
        journal.put(`restore-${id}-${table}`, String(offset), rows[0]);
      }
    }
    const audit = await this.db.manager.query("SELECT * FROM audit_logs WHERE action IN ('destruction','legal_hold') ORDER BY created_at,id");
    for (const row of audit) journal.put(`restore-${id}-audit_logs`, row.id, row);
    journal.put('session', id, { id, operation: 'restore', status: 'active', operationId: payload.operationId });
    return { sessionId: id, maintenanceProtected: true };
  }
  private async applyRestore(payload: any) {
    const s = this.settings(), journal = this.journal(), session = journal.get('session', payload.sessionId);
    if (!this.maintenance() || !session || session.operation !== 'restore' || session.status !== 'active')
      fail(409, 'INVALID_RESTORE_SESSION', 'Phiên khôi phục không hợp lệ.');
    const runner = this.db.createQueryRunner();
    try { await new DestructionWorkflow1792368000000().up(runner); } finally { await runner.release(); }
    // Insert only absent immutable rows; divergence keeps maintenance enabled for manual review.
    const order = ['destruction_requests', 'destruction_items', 'destruction_attachments', 'destruction_attachment_content',
      'destruction_otp_challenges', 'destruction_approvals', 'destruction_jobs', 'destruction_backup_dispositions', 'destruction_idempotency', 'audit_logs'];
    for (const table of order) {
      for (const row of journal.iterate(`restore-${session.id}-${table}`)) {
        const entity = this.db.entityMetadatas.find(m => m.tableName === table)!;
        const pk = entity.primaryColumns[0].databaseName;
        const existing = await this.db.manager.query(`SELECT * FROM \`${table}\` WHERE \`${pk}\`=?`, [row[pk]]);
        if (existing.length) {
          if (digest(existing[0]) === digest(row)) continue;
          if (!['destruction_requests', 'destruction_items', 'destruction_jobs', 'destruction_otp_challenges', 'destruction_backup_dispositions'].includes(table))
            fail(409, 'RESTORE_METADATA_CONFLICT', 'Chứng từ/audit bất biến trong bản restore khác nhật ký được bảo vệ. Cần đối chiếu vận hành.');
        }
        const columns = Object.keys(row);
        const values = columns.map(column => {
          const definition = entity.columns.find(c => c.databaseName === column);
          if (row[column] !== null && ['datetime', 'timestamp'].includes(String(definition?.type)) && typeof row[column] === 'string')
            return new Date(row[column]);
          if (row[column] !== null && definition?.type === 'date' && typeof row[column] === 'string') return row[column].slice(0, 10);
          return definition?.type === 'json' && row[column] !== null && typeof row[column] === 'object' ? JSON.stringify(row[column]) : row[column];
        });
        if (existing.length) {
          await this.db.manager.query(`UPDATE \`${table}\` SET ${columns.map(c => `\`${c}\`=?`).join(',')} WHERE \`${pk}\`=?`, [...values, row[pk]]);
        } else await this.db.manager.query(`INSERT INTO \`${table}\` (${columns.map(c => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`, values);
      }
    }
    for (const exclusion of journal.iterate('exclusion')) {
      const doc = await this.db.manager.findOne(Document, { where: { id: exclusion.documentId }, relations: ['file'] });
      if (!doc) fail(409, 'RESTORE_DOCUMENT_MISSING', 'Thiếu metadata hồ sơ đã hủy trong bản restore. Cần phục hồi metadata trước khi công bố.');
      const covered = new Map(exclusion.objects.map(o => [keyIdentity(o.key), o.sha256]));
      const rows = [{ storage_path: doc.storagePath }, ...(doc.file ? [{ storage_path: doc.file.storageKey }] : []),
        ...await this.db.manager.query('SELECT storage_path FROM document_versions WHERE document_id=?', [doc.id])];
      for (const row of rows) {
        const key = relativeKey(s.archive, row.storage_path);
        if (!covered.has(keyIdentity(key))) fail(409, 'RESTORE_CONTENT_NOT_COVERED', 'Bản restore chứa phiên bản chưa có trong tombstone. Cần kiểm tra trước khi công bố.');
        const filename = safePath(s.archive, key, true);
        if (fs.existsSync(filename)) {
          await this.ownership(doc.id, filename);
          if (await hashFile(filename) !== covered.get(keyIdentity(key))) fail(409, 'RESTORE_HASH_CHANGED', 'Nội dung restore không khớp tombstone.');
          await fs.promises.unlink(safePath(s.archive, key));
        }
      }
      const item = await this.db.manager.findOneBy(DestructionItem, { requestId: exclusion.requestId, documentId: doc.id });
      if (item?.status === 'destroyed') {
        await this.db.manager.update(Document, doc.id, { status: DocumentStatus.DESTROYED, destructionRequestId: exclusion.requestId,
          destroyedAt: item.destroyedAt, destructionStartedAt: doc.destructionStartedAt || item.destroyedAt });
      } else if (!doc.destructionRequestId) {
        await this.db.manager.update(Document, doc.id, { destructionRequestId: exclusion.requestId, destructionStartedAt: new Date() });
      }
    }
    const evidenceId = randomUUID(); journal.put('session', session.id, { ...session, verified: true, evidenceId });
    return { applied: true, verified: true, evidenceId };
  }
  private async endRestore(payload: any) {
    const s = this.settings(), journal = this.journal(), session = journal.get('session', payload.sessionId);
    const marker = JSON.parse(fs.readFileSync(path.join(s.state, 'maintenance.json'), 'utf8'));
    if (!session?.verified || marker.sessionId !== session.id || payload.success !== true)
      fail(409, 'RESTORE_UNVERIFIED', 'Chưa xác nhận áp lại tombstone; tiếp tục bảo trì.');
    journal.put('session', session.id, { ...session, status: 'closed' });
    await fs.promises.unlink(path.join(s.state, 'maintenance.json'));
    return { closed: true };
  }
  private async cancelPreparingRestore(payload: any) {
    const s = this.settings(), journal = this.journal(), session = journal.get('session', payload.sessionId);
    const marker = JSON.parse(fs.readFileSync(path.join(s.state, 'maintenance.json'), 'utf8'));
    if (session?.operation !== 'restore' || session.status !== 'preparing' || marker.sessionId !== session.id)
      fail(409, 'RESTORE_CANNOT_CANCEL', 'Chỉ hủy được phiên chuẩn bị thất bại trước khi import bắt đầu.');
    journal.put('session', session.id, { ...session, status: 'cancelled' });
    fs.unlinkSync(path.join(s.state, 'maintenance.json'));
    return { closed: true };
  }
}
