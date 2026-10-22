import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { Document, DocumentStatus } from '../entities/document.entity';
import { DestructionRequest as Request, DestructionJob as Job, DestructionItem as Item,
  DestructionApproval as Approval, DestructionBackupDisposition as Disposition } from '../entities/destruction.entity';
import { DestructionService } from './destruction.service';
import { DestructionInfrastructure } from './destruction.infrastructure';
import { approvalsValid, digest, fail } from './destruction.rules';

/** The gateway owns the deletion WAL and idempotent per-object receipts across process crashes. */
@Injectable()
export class DestructionWorker {
  private readonly logger = new Logger(DestructionWorker.name);
  private running = false;
  constructor(private readonly db: DataSource, private readonly service: DestructionService,
    private readonly infrastructure: DestructionInfrastructure) {}

  @Cron('*/30 * * * * *')
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      if (this.infrastructure.maintenance()) return;
      if (await this.infrastructure.health()) {
        const now = await this.service.now();
        const jobs = await this.db.getRepository(Job).createQueryBuilder('j')
          .where("(j.status = 'scheduled' AND j.runAt <= :now) OR (j.status = 'processing' AND j.leaseExpiry <= :now)", { now })
          .orderBy('j.runAt', 'ASC').take(10).getMany();
        for (const job of jobs) await this.run(job.requestId);
      }
      // Purge existing tombstones even when new requests are disabled or SMTP/scanner readiness fails.
      await this.reconcileBackups();
    } catch {
      this.logger.error('Không thể thực hiện chu kỳ hủy hồ sơ; cần kiểm tra hạ tầng.');
    } finally { this.running = false; }
  }

  private async claim(id: string, owner: string): Promise<boolean> {
    return this.db.transaction('READ COMMITTED', async m => {
      // All paths lock the request before the job/document rows, including withdrawal.
      const r = await m.findOne(Request, { where: { id }, lock: { mode: 'pessimistic_write' } });
      const job = await m.findOne(Job, { where: { requestId: id }, lock: { mode: 'pessimistic_write' } });
      const now = await this.service.now(m);
      if (!r || !job || !r.executeAfter || r.executeAfter > now) return false;
      if (!['scheduled', 'processing'].includes(r.status) || !['scheduled', 'processing'].includes(job.status)
        || (job.leaseExpiry && job.leaseExpiry > now)) return false;
      const health = await this.infrastructure.requireReady();
      if (digest(health.backupPolicy) !== digest(r.backupPolicy)) fail(409, 'POLICY_CHANGED', 'Chính sách backup đã thay đổi.');
      const approvals = await m.findBy(Approval, { requestId: id });
      const { docs } = await this.service.checkItems(m, r, now, true);
      if (!approvalsValid(r, docs, approvals, await this.service.approvalReviewers(m, approvals)))
        fail(409, 'INVALID_APPROVALS', 'Lượt duyệt hoặc vai trò/khoa của người duyệt không còn hợp lệ.');
      for (const doc of docs) if (doc.status !== DocumentStatus.DESTROYED && !doc.destructionStartedAt)
        await m.update(Document, doc.id, { destructionStartedAt: now });
      const old = r.status;
      r.status = 'processing'; r.version++;
      job.status = 'processing'; job.leaseOwner = owner; job.leaseExpiry = new Date(now.getTime() + 120000); job.attempts++;
      await m.save(Job, job); await m.save(Request, r);
      await this.service.audit(m, null, r, 'Worker đã nhận việc hủy hồ sơ', old);
      return true;
    });
  }

  private async locked<T>(id: string, owner: string, operation: (m: any, r: Request, job: Job, now: Date) => Promise<T>) {
    return this.db.transaction('READ COMMITTED', async m => {
      const r = await m.findOneOrFail(Request, { where: { id }, lock: { mode: 'pessimistic_write' } });
      const job = await m.findOneOrFail(Job, { where: { requestId: id }, lock: { mode: 'pessimistic_write' } });
      const now = await this.service.now(m);
      if (job.status !== 'processing' || job.leaseOwner !== owner || !job.leaseExpiry || job.leaseExpiry <= now)
        fail(409, 'LEASE_LOST', 'Worker đã mất quyền xử lý công việc.');
      job.leaseExpiry = new Date(now.getTime() + 120000);
      await m.save(Job, job);
      return operation(m, r, job, now);
    });
  }

  async run(id: string) {
    const owner = randomUUID();
    let claimed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatBusy = false;
    let phase = 'claim';
    try {
      claimed = await this.claim(id, owner);
      if (!claimed) return;
      heartbeat = setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void this.locked(id, owner, async () => {}).catch(() => {}).finally(() => { heartbeatBusy = false; });
      }, 20000);
      heartbeat.unref();
      phase = 'load_items';
      const request = await this.db.manager.findOneByOrFail(Request, { id });
      const items = await this.db.manager.find(Item, { where: { requestId: id }, order: { documentId: 'ASC' } });
      for (const item of items) {
        if (item.status === 'destroyed') continue;
        let manifest = item.executionResult?.manifest;
        if (!manifest) {
          phase = 'inventory';
          const doc = (await this.service.documents(this.db.manager, [item.documentId]))[0];
          const versions = await this.db.manager.query('SELECT id, version, storage_path, sha256_checksum FROM document_versions WHERE document_id = ? ORDER BY version', [doc.id]);
          // Trusted inventory must reject shared objects, missing initial files and paths outside its configured realpath SAN root.
          manifest = await this.infrastructure.call('content/inventory', { requestId: id, documentId: doc.id, leaseOwner: owner,
            snapshot: item.snapshot, currentStorageKey: doc.file?.storageKey ?? doc.storagePath, versions });
          if (manifest.documentId !== doc.id || manifest.primaryChecksum !== item.snapshot.checksum
            || manifest.contentVersion !== item.snapshot.version || manifest.complete !== true || manifest.safe !== true
            || manifest.exclusiveOwnership !== true || !Array.isArray(manifest.objects) || !manifest.objects.length
            || !manifest.id || manifest.objects.some(o => !o.key || !/^[a-f0-9]{64}$/i.test(o.sha256)))
            fail(409, 'UNSAFE_MANIFEST', 'Không thể xác nhận danh mục nội dung an toàn để hủy.');
          await this.locked(id, owner, async (m, r, job) => {
            await this.service.checkItems(m, r, await this.service.now(m), true);
            item.executionResult = { manifest, operationId: digest([id, item.documentId, manifest.id]) };
            item.status = 'prepared';
            await m.save(Item, item);
            job.checkpoint = { documentId: item.documentId, phase: 'prepared' }; await m.save(Job, job);
          });
        }
        // The immutable policy records unused destinations; only actual stores receive tombstones.
        for (const target of request.backupPolicy.targets.filter(t => t.enabled !== false)) {
          phase = 'backup_exclusion';
          const operationId = digest([id, item.documentId, target.key]);
          const exclusion = await this.infrastructure.call('backup/exclude', { operationId, requestId: id, documentId: item.documentId,
            target: target.key, objects: manifest.objects, backupPolicy: request.backupPolicy });
          if (exclusion.excluded !== true || exclusion.restoreProtected !== true || !exclusion.evidenceId)
            fail(503, 'BACKUP_EXCLUSION_UNCONFIRMED', 'Chưa xác nhận ngăn sao lưu và khôi phục nội dung đã hủy.');
          await this.locked(id, owner, async (m, _r, _job, now) => {
            const existing = await m.findOneBy(Disposition, { requestId: id, documentId: item.documentId, target: target.key });
            if (!existing) await m.insert(Disposition, { id: randomUUID(), requestId: id, documentId: item.documentId,
              target: target.key, objects: manifest.objects, status: 'excluded', excludedAt: now,
              purgeDueAt: new Date(now.getTime() + target.purgeWithinDays * 86400000), evidence: { exclusion: exclusion.evidenceId } });
          });
        }
        // Persist intent before invoking an irreversible operation; gateway recovers its object WAL on replay.
        phase = 'prepare_deletion';
        await this.locked(id, owner, async (m, r, job, now) => {
          await this.service.checkItems(m, r, now, true);
          item.status = 'deleting'; await m.save(Item, item);
          job.checkpoint = { documentId: item.documentId, phase: 'deleting' }; await m.save(Job, job);
        });
        const operationId = item.executionResult.operationId;
        phase = 'destroy';
        const receipt = await this.infrastructure.call('content/destroy', { operationId, requestId: id,
          documentId: item.documentId, manifestId: manifest.id, manifestDigest: digest(manifest), leaseOwner: owner });
        if (receipt.operationId !== operationId || receipt.manifestId !== manifest.id || receipt.verifiedAbsent !== true
          || receipt.primaryChecksum !== item.snapshot.checksum || !receipt.evidenceId
          || !Array.isArray(receipt.objects) || receipt.objects.length !== manifest.objects.length
          || !manifest.objects.every(o => receipt.objects.some(r => r.key === o.key && r.sha256 === o.sha256 && r.verifiedAbsent === true && r.evidenceId)))
          fail(503, 'DELETION_UNCONFIRMED', 'Chưa xác nhận xóa toàn bộ nội dung. Cần kiểm tra vận hành.');
        phase = 'confirm_deletion';
        await this.locked(id, owner, async (m, r, job, now) => {
          const doc = (await this.service.documents(m, [item.documentId], true))[0];
          if (doc.legalHold || doc.destructionRequestId !== id) fail(409, 'DOCUMENT_CHANGED', 'Điều kiện hồ sơ đã thay đổi.');
          item.status = 'destroyed'; item.destroyedAt = now; item.checksumAtDestruction = receipt.primaryChecksum;
          item.executionResult = { ...item.executionResult, receipt };
          await m.save(Item, item);
          await m.update(Document, item.documentId, { status: DocumentStatus.DESTROYED, destroyedAt: now });
          job.checkpoint = { documentId: item.documentId, phase: 'destroyed' }; await m.save(Job, job);
          await this.service.audit(m, null, r, `Đã xác nhận hủy hồ sơ ${item.snapshot.code}`, r.status);
        });
      }
      phase = 'finalize';
      await this.locked(id, owner, async (m, r, job, now) => {
        const remaining = await m.getRepository(Item).createQueryBuilder('i').where('i.requestId = :id AND i.status != :status', { id, status: 'destroyed' }).getCount();
        if (remaining) fail(409, 'DESTRUCTION_INCOMPLETE', 'Vẫn còn nội dung chưa xác nhận hủy.');
        r.status = 'destroyed'; r.destroyedAt = now; r.version++; r.failureReason = null;
        job.status = 'done'; job.leaseOwner = null; job.leaseExpiry = null;
        await m.save(Request, r); await m.save(Job, job);
        await this.service.audit(m, null, r, 'Đã hủy hết nội dung; chờ biên bản hủy', 'processing');
      });
    } catch (error) {
      // Detailed storage errors stay with the gateway's restricted operational logs.
      // Only expose a bounded machine code, never raw SQL, paths or error messages.
      const rawCode = error?.getResponse?.()?.code ?? error?.code;
      const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'INFRASTRUCTURE_ERROR';
      await this.db.transaction('READ COMMITTED', async m => {
        const r = await m.findOne(Request, { where: { id }, lock: { mode: 'pessimistic_write' } });
        const job = await m.findOne(Job, { where: { requestId: id }, lock: { mode: 'pessimistic_write' } });
        if (!r || !job || (claimed ? job.leaseOwner !== owner : r.status !== 'scheduled')) return;
        const oldStatus = r.status;
        r.status = 'failed'; r.version++; r.failureReason = 'Không thể xác nhận điều kiện hoặc kết quả hủy. Cần kiểm tra vận hành.';
        job.status = 'failed'; job.lastError = `${r.failureReason} [${phase}:${code}]`; job.leaseOwner = null; job.leaseExpiry = null;
        await m.save(Request, r); await m.save(Job, job);
        await this.service.audit(m, null, r, 'Hủy hồ sơ gặp lỗi; giữ tiến độ và yêu cầu kiểm tra vận hành', oldStatus, 'failure');
      });
      this.logger.error(`Công việc hủy ${id} cần kiểm tra vận hành (${code}; phase=${phase}).`);
    } finally { if (heartbeat) clearInterval(heartbeat); }
  }

  async reconcileBackups() {
    const dispositions = await this.db.getRepository(Disposition).createQueryBuilder('d')
      .where('d.status != :status', { status: 'purged' }).orderBy('d.checkedAt', 'ASC').addOrderBy('d.purgeDueAt', 'ASC').take(100).getMany();
    for (const disposition of dispositions) {
      try {
        const receipt = await this.infrastructure.call('backup/purge', { operationId: digest([disposition.id, 'purge']),
          requestId: disposition.requestId, documentId: disposition.documentId, target: disposition.target,
          objects: disposition.objects, purgeDueAt: disposition.purgeDueAt });
        const now = await this.service.now();
        const purged = receipt.verifiedAbsent === true && !!receipt.evidenceId;
        await this.db.manager.update(Disposition, disposition.id, { status: purged ? 'purged' : now > disposition.purgeDueAt ? 'overdue' : 'pending_purge',
          purgedAt: purged ? now : null, checkedAt: now, evidence: { ...disposition.evidence, purge: receipt.evidenceId ?? null }, error: null });
        if (!purged && now > disposition.purgeDueAt) this.logger.error(`Bản sao lưu quá hạn hủy: ${disposition.id}`);
      } catch {
        await this.db.manager.update(Disposition, disposition.id, { status: 'error', checkedAt: await this.service.now(), error: 'Không thể xác nhận kết quả xóa bản sao lưu.' });
        this.logger.error(`Cần xử lý bản sao lưu: ${disposition.id}`);
      }
    }
  }
}
