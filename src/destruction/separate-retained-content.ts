import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Document } from '../entities/document.entity';
import { User } from '../entities/user.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { DestructionRequest, DestructionJob, DestructionItem, DestructionBackupDisposition } from '../entities/destruction.entity';
import { LocalDestructionInfrastructure } from './local-infrastructure';
import { encryptionEnabled, encryptArchiveFile, loadArchiveKeys } from '../common/archive-crypto';
import { inspectDestructionContent } from './content-integrity';
import { hashFile, relativeKey, safePath } from './local-storage';
import { fail } from './destruction.rules';

interface Options { destroyId: string; keepId: string; actorId?: string; reason?: string; apply: boolean }

/** Operator repair: move only the retained record's references, never the approved snapshot or original bytes. */
export async function separateRetainedContent(db: DataSource, local: LocalDestructionInfrastructure, options: Options) {
  const { destroyId, keepId, actorId, apply } = options;
  if (destroyId === keepId) fail(422, 'SAME_DOCUMENT', 'Hai hồ sơ phải khác nhau.');
  return local.exclusive(async () => {
    if (local.maintenance()) fail(409, 'MAINTENANCE', 'Đang khôi phục dữ liệu.');
    const settings = local.settings();
    const initial = await db.manager.findOneBy(Document, { id: destroyId });
    if (!initial?.destructionRequestId) fail(409, 'NO_DESTRUCTION_REQUEST', 'Hồ sơ chưa có đề nghị hủy.');
    return db.transaction('READ COMMITTED', async m => {
      const requestId = initial.destructionRequestId!;
      const request = await m.findOne(DestructionRequest, { where: { id: requestId }, lock: { mode: 'pessimistic_write' } });
      const job = await m.findOne(DestructionJob, { where: { requestId }, lock: { mode: 'pessimistic_write' } });
      if (request?.status !== 'failed' || job?.status !== 'failed')
        fail(409, 'REQUEST_NOT_FAILED', 'Chỉ tách khi đề nghị và công việc hủy đã dừng do lỗi.');
      const docs = new Map<string, Document>();
      for (const id of [destroyId, keepId].sort()) {
        const doc = await m.findOne(Document, { where: { id }, relations: ['file'], lock: { mode: 'pessimistic_write' } });
        if (!doc) fail(404, 'DOCUMENT_NOT_FOUND', 'Không tìm thấy hồ sơ.');
        docs.set(id, doc);
      }
      const destroy = docs.get(destroyId)!, keep = docs.get(keepId)!;
      if (destroy.destructionRequestId !== requestId || destroy.status === 'destroyed' || destroy.destroyedAt)
        fail(409, 'DESTRUCTION_CHANGED', 'Trạng thái hồ sơ cần hủy đã thay đổi.');
      if (keep.destructionRequestId || keep.destructionStartedAt || keep.destroyedAt || keep.legalHold
        || !['stored', 'approved'].includes(keep.status))
        fail(409, 'RETAINED_DOCUMENT_LOCKED', 'Hồ sơ cần giữ phải đang lưu kho, không bị khóa hoặc thuộc đề nghị hủy.');
      const item = await m.findOneBy(DestructionItem, { requestId, documentId: destroyId });
      if (!item || item.status !== 'pending' || item.executionResult
        || await m.countBy(DestructionBackupDisposition, { requestId, documentId: destroyId }))
        fail(409, 'DESTRUCTION_ALREADY_PREPARED', 'Đã có checkpoint hoặc tombstone; cần đối chiếu journal riêng.');
      if (item.snapshot.checksum !== destroy.sha256Checksum || item.snapshot.version !== destroy.version
        || item.snapshot.storagePath !== destroy.storagePath || item.snapshot.fileId !== (destroy.file?.id ?? null))
        fail(409, 'SNAPSHOT_CHANGED', 'Nội dung hồ sơ cần hủy không khớp snapshot.');
      if (apply) {
        const actor = actorId ? await m.findOneBy(User, { id: actorId }) : null;
        if (!actor?.isActive || actor.role !== 'admin' || !options.reason?.trim() || options.reason.length > 4000)
          fail(422, 'ADMIN_AND_REASON_REQUIRED', 'Cần ID admin đang hoạt động và lý do vận hành.');
      }
      const versions = async (id: string) => m.query(
        'SELECT id,storage_path,sha256_checksum FROM document_versions WHERE document_id=? ORDER BY version FOR UPDATE', [id]);
      const destroyVersions = await versions(destroyId), keepVersions = await versions(keepId);
      const canonical = (filename: string) => safePath(settings.archive, relativeKey(settings.archive, filename));
      const identity = (filename: string) => {
        const real = fs.realpathSync(canonical(filename));
        return process.platform === 'win32' ? real.toLowerCase() : real;
      };
      // Separate only paths used by the approved record, including all historic versions.
      const destroyPaths = new Set<string>();
      for (const filename of [destroy.file?.storageKey, destroy.storagePath, ...destroyVersions.map(v => v.storage_path)].filter(Boolean))
        destroyPaths.add(identity(filename));
      if (keep.file && identity(keep.file.storageKey) !== identity(keep.storagePath))
        fail(409, 'RETAINED_PATH_CONFLICT', 'Đường dẫn file và metadata hồ sơ cần giữ không đồng nhất.');
      const refs = [{ id: null as string | null, filename: keep.file?.storageKey || keep.storagePath, checksum: keep.sha256Checksum },
        ...keepVersions.map(v => ({ id: v.id as string, filename: v.storage_path as string, checksum: v.sha256_checksum as string }))];
      const plan = new Map<string, { source: string; checksum: string; versions: string[]; primary: boolean; encrypt?: boolean; destination?: string }>();
      for (const ref of refs) {
        const key = identity(ref.filename);
        if (!destroyPaths.has(key)) continue;
        if (!/^[a-f0-9]{64}$/i.test(ref.checksum || '')) fail(409, 'CHECKSUM_REQUIRED', 'Thiếu checksum tin cậy.');
        let entry = plan.get(key);
        if (!entry) {
          entry = { source: canonical(ref.filename), checksum: ref.checksum, versions: [], primary: false };
          plan.set(key, entry);
        }
        if (entry.checksum !== ref.checksum) fail(409, 'CHECKSUM_CONFLICT', 'Checksum tham chiếu không đồng nhất.');
        if (ref.id) entry.versions.push(ref.id); else entry.primary = true;
      }
      for (const entry of plan.values()) {
        const owners = await local.inspectOwnership(destroyId, entry.source);
        if (owners.hardLinks !== '1' || owners.references.some(ref => ref.id !== keepId || ref.status === 'personal'))
          fail(409, 'ADDITIONAL_SHARED_CONTENT', 'File còn hard link hoặc tham chiếu ngoài hồ sơ cần giữ.');
        const content = await inspectDestructionContent(entry.source, entry.checksum);
        entry.encrypt = !content.encrypted && encryptionEnabled();
        if (entry.encrypt) loadArchiveKeys();
      }
      const result = { requestId, destroyId, keepId, objects: plan.size,
        encryptLegacyObjects: [...plan.values()].filter(entry => entry.encrypt).length, applied: apply && plan.size > 0 };
      if (!apply || !plan.size) return result;
      const separationId = randomUUID();
      const directoryKey = `retained/${keepId}/${separationId}`;
      await fs.promises.mkdir(safePath(settings.archive, directoryKey, true), { recursive: true, mode: 0o700 });
      // Validate the completed parent tree against junctions before copying.
      safePath(settings.archive, directoryKey);
      for (const entry of plan.values()) {
        const destination = safePath(settings.archive, `${directoryKey}/${randomUUID()}${entry.encrypt ? '.lths' : path.extname(entry.source)}`, true);
        const before = await hashFile(entry.source);
        if (entry.encrypt) await encryptArchiveFile(canonical(entry.source), destination, entry.checksum);
        else await fs.promises.copyFile(canonical(entry.source), destination, fs.constants.COPYFILE_EXCL);
        const handle = await fs.promises.open(destination, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        if ((!entry.encrypt && await hashFile(destination) !== before) || await hashFile(entry.source) !== before
          || (await inspectDestructionContent(destination, entry.checksum)).checksum !== entry.checksum)
          fail(409, 'COPY_VERIFICATION_FAILED', 'Không xác minh được bản sao độc lập.');
        entry.destination = destination;
      }
      // Nullable file_id is the supported independent-path representation. Keep the shared
      // files row unchanged: it is frozen by the approved request and hash has a unique index.
      for (const entry of plan.values()) {
        if (entry.primary) await m.update(Document, keepId, { file: null as any, storagePath: entry.destination! });
        for (const id of entry.versions) await m.query('UPDATE document_versions SET storage_path=? WHERE id=? AND document_id=?', [entry.destination, id, keepId]);
      }
      const [clock] = await m.query('SELECT UTC_TIMESTAMP(3) AS now');
      await m.save(AuditLog, m.create(AuditLog, { id: randomUUID(), actor: { id: actorId }, action: 'destruction', createdAt: clock.now,
        metadata: { requestId, description: `Đã tách lưu trữ hồ sơ cần giữ ${keepId}: ${options.reason!.trim()}`,
          separationId, keepId, destroyId, result: 'success', copies: [...plan.values()].map(entry => ({
            from: relativeKey(settings.archive, entry.source), to: relativeKey(settings.archive, entry.destination!), checksum: entry.checksum,
          })) } }));
      // Never delete copies on a transaction/connection error: commit outcome can be ambiguous.
      // Original bytes, the failed request, approvals and all deletion checkpoints are untouched.
      return result;
    });
  });
}
