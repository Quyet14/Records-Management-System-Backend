// Readiness check and explicit local-state initialization. Never deletes document content.
require('dotenv').config();
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const database = require('../dist/config/typeorm.config').default;
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { DestructionInfrastructure } = require('../dist/destruction/destruction.infrastructure');
async function main() {
  const documentIndex = process.argv.indexOf('--document');
  const documentId = documentIndex >= 0 ? process.argv[documentIndex + 1] : null;
  if (documentIndex >= 0 && (process.argv.length !== 4 || documentIndex !== 2
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId || '')))
    throw Error('Usage: node scripts/check-destruction.cjs --document <document-uuid> (read-only).');
  const config = new ConfigService(process.env);
  if (process.argv.includes('--paths')) {
    // Paths only: never print the environment, SQL credentials, SMTP credentials or OTP secrets.
    for (const [key, fallback] of [
      ['UPLOAD_ARCHIVE_DIR', './storage/archive'], ['BACKUP_DIR', './storage/backup'],
      ['DESTRUCTION_LOCAL_CONFIG', ''], ['DESTRUCTION_STATE_DIR', './storage/destruction-state'],
      ['DESTRUCTION_BACKUP_STAGING_ROOT', './storage/destruction-backup-staging'],
    ]) {
      const value = process.env[key] || fallback;
      const resolved = value ? path.resolve(value) : '(not configured)';
      console.log(`${key}=${resolved} | exists=${!!value && fs.existsSync(resolved)}`);
    }
    return;
  }
  if (process.argv.includes('--init')) {
    if (!process.env.DESTRUCTION_LOCAL_CONFIG) throw Error('Set DESTRUCTION_LOCAL_CONFIG to the approved local policy JSON first.');
    const directories = [process.env.DESTRUCTION_STATE_DIR || './storage/destruction-state',
      process.env.DESTRUCTION_BACKUP_STAGING_ROOT || './storage/destruction-backup-staging'];
    for (const directory of directories) fs.mkdirSync(path.resolve(directory), { recursive: true, mode: 0o700 });
    // The provider validates disjoint, existing authoritative targets before writing any marker.
    const probe = new LocalDestructionInfrastructure(config, {});
    try { probe.initializeStorage(); } finally { probe.onModuleDestroy(); }
    console.log('Initialized protected local directories and backup target identities. No document content was changed.');
  }
  const ds = new DataSource({ ...database(), synchronize: false, migrationsRun: false, logging: false });
  await ds.initialize();
  if (documentId) {
    try {
      const { Document } = require('../dist/entities/document.entity');
      const { eligibilityReasons, approvalsValid, requiredApprovals, approverScope, canApproveOwnRequest } = require('../dist/destruction/destruction.rules');
      if (typeof eligibilityReasons !== 'function') throw Error('Deploy updated source and run npm run build first.');
      const doc = await ds.manager.findOne(Document, { where: { id: documentId }, relations: ['documentType', 'file'] });
      if (!doc) throw Error('Document not found.');
      const { DestructionRequest, DestructionItem, DestructionJob, DestructionApproval } = require('../dist/entities/destruction.entity');
      console.log(`DOCUMENT: ${documentId} (read-only; no changes made)`);
      console.log(`STATUS: ${doc.status} | destructionStartedAt=${doc.destructionStartedAt?.toISOString() || '-'} | destroyedAt=${doc.destroyedAt?.toISOString() || '-'}`);
      if (doc.destructionRequestId) {
        const requestId = doc.destructionRequestId;
        const request = await ds.manager.findOneBy(DestructionRequest, { id: requestId });
        const item = await ds.manager.findOneBy(DestructionItem, { requestId, documentId });
        const job = await ds.manager.findOneBy(DestructionJob, { requestId });
        console.log(`REQUEST: ${requestId} | status=${request?.status || 'missing'} | item=${item?.status || 'missing'} | job=${job?.status || 'missing'}`);
        console.log(`CHECKPOINT: phase=${job?.checkpoint?.phase || '-'} | manifest=${!!item?.executionResult?.manifest} | deletionReceipt=${!!item?.executionResult?.receipt}`);
        if (request?.failureReason) console.log(`FAILURE: ${request.failureReason}`);
        if (job?.lastError) console.log(`JOB ERROR: ${job.lastError}`);
        if (request) {
          const { User } = require('../dist/entities/user.entity');
          const { DestructionService } = require('../dist/destruction/destruction.service');
          const service = new DestructionService(ds, new DestructionInfrastructure(config));
          const requestItems = await ds.manager.findBy(DestructionItem, { requestId });
          const documents = await service.documents(ds.manager, requestItems.map(row => row.documentId));
          const approvals = await ds.manager.findBy(DestructionApproval, { requestId });
          const reviewers = await service.approvalReviewers(ds.manager, approvals);
          console.log(`APPROVALS: valid=${approvalsValid(request, documents, approvals, reviewers)} | required=${request.requiredApprovals} | currentPolicyRequired=${requiredApprovals(documents)} | recorded=${approvals.length} | activeReviewers=${reviewers.length}`);
          console.log(`REQUEST CREATOR: ${request.createdBy}`);
          for (const approval of approvals) {
            const user = await ds.manager.findOne(User, { where: { id: approval.userId }, relations: ['department'] });
            const actor = reviewers.find(row => row.id === approval.userId);
            const self = approval.userId === request.createdBy;
            const scope = !!actor && approverScope(actor, documents);
            const selfAllowed = !self || (!!actor && canApproveOwnRequest(request, actor, documents));
            console.log(`APPROVER: ${approval.userId} | name=${user?.fullName || '-'} | active=${!!user?.isActive} | role=${user?.role || 'missing'} | department=${user?.department?.id || '-'} | scope=${scope} | digestMatches=${approval.digest === request.digest} | isCreator=${self} | creatorApprovalAllowed=${selfAllowed}`);
            if (!actor) console.log('APPROVAL BLOCKER: người duyệt không còn tồn tại hoặc tài khoản bị vô hiệu hóa.');
            else if (!scope) console.log('APPROVAL BLOCKER: vai trò/khoa hiện tại của người duyệt không có quyền duyệt toàn bộ đề nghị.');
            if (!selfAllowed) console.log('APPROVAL BLOCKER: người lập đang tự duyệt nhưng không đáp ứng ngoại lệ Trưởng khoa tự duyệt hồ sơ thường do mình tải lên.');
            if (approval.digest !== request.digest) console.log('APPROVAL BLOCKER: lượt duyệt không gắn với nội dung đề nghị hiện tại.');
          }
          if (approvals.length !== request.requiredApprovals) console.log('APPROVAL BLOCKER: số lượt duyệt không khớp số lượt bắt buộc.');
          if (request.requiredApprovals !== requiredApprovals(documents)) console.log('APPROVAL BLOCKER: chính sách số lượt duyệt không khớp mức bảo mật hiện tại.');
          if (new Set(approvals.map(row => row.userId)).size !== approvals.length) console.log('APPROVAL BLOCKER: trùng người duyệt.');
          if (request.requiredApprovals === 2 && (!reviewers.some(row => row.role === 'admin') || !reviewers.some(row => row.role === 'department_head')))
            console.log('APPROVAL BLOCKER: cần một Admin và một Trưởng khoa hợp lệ; không thay bằng hai người cùng vai trò.');
        }
        if (doc.status !== 'destroyed' && doc.destructionStartedAt) {
          console.log('VISIBILITY: hồ sơ đã bị khóa khỏi kho khi bắt đầu hủy, nhưng chưa được xác nhận hủy thành công. Không tự đổi status hoặc xóa checkpoint.');
        }
        if (item?.status === 'pending') {
          console.log('PENDING: chưa lưu manifest đã kiểm kê; chưa có bằng chứng hủy file của hồ sơ này trong DB. Kiểm tra log worker tại thời điểm lỗi.');
        }
        if (request?.status === 'failed') {
          console.log('NEXT: kiểm tra mã lỗi trong log PM2 và journal hủy; chỉ dùng retry-destruction.cjs sau khi đã đối chiếu bằng chứng và xử lý nguyên nhân.');
        }
        if (request?.status === 'failed' && new DestructionInfrastructure(config).provider() === 'local') {
          const probe = new LocalDestructionInfrastructure(config, ds);
          const versions = await ds.manager.query('SELECT storage_path FROM document_versions WHERE document_id=? ORDER BY version', [documentId]);
          const filenames = [...new Set([doc.file?.storageKey, doc.storagePath, ...versions.map(v => v.storage_path)].filter(Boolean))];
          for (const [index, filename] of filenames.entries()) {
            try {
              const report = await probe.inspectOwnership(documentId, filename);
              console.log(`CONTENT ${index + 1}: hardLinks=${report.hardLinks} | otherReferences=${report.references.length}`);
              for (const ref of report.references) console.log(`SHARED WITH: ${ref.status === 'personal' ? 'personal_file' : 'document'}=${ref.id} | status=${ref.status}`);
            } catch (error) {
              const code = error?.getResponse?.()?.code || error?.code;
              console.log(`CONTENT ${index + 1}: inspection failed (${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'INSPECTION_ERROR'})`);
            }
          }
        }
      }
      const reasons = eligibilityReasons(doc);
      if (!/^[a-f0-9]{64}$/i.test(doc.sha256Checksum || '')) reasons.push('Thiếu hoặc sai SHA-256 của file.');
      if (!(Number(doc.fileSizeBytes) >= 0)) reasons.push('Dung lượng file không hợp lệ.');
      if (reasons.length) {
        reasons.forEach(reason => console.log(`BLOCKED: ${reason === 'hồ sơ đang thuộc một đề nghị hủy khác' && doc.destructionRequestId
          ? `hồ sơ đang gắn với đề nghị hủy ${doc.destructionRequestId}; không thể tạo đề nghị mới`
          : reason}`));
        process.exitCode = 1;
      } else console.log('ELIGIBLE: document metadata allows an early request; access, infrastructure, evidence and approvals are checked separately.');
    } finally { await ds.destroy(); }
    return;
  }
  const local = new LocalDestructionInfrastructure(config, ds);
  try {
    if (process.argv.includes('--list-sessions')) { console.table(local.sessions()); return; }
    const closeIndex = process.argv.indexOf('--close-backup-session');
    if (closeIndex >= 0) {
      const sessionId = process.argv[closeIndex + 1];
      if (!process.argv.includes('--confirm-stopped') || !/^[a-f0-9-]{36}$/i.test(sessionId || ''))
        throw Error('Verify the backup process has stopped, then use --close-backup-session <uuid> --confirm-stopped.');
      await local.call('backup/end', { sessionId, success: false });
      console.log('Closed the inspected stopped backup session as unsuccessful.'); return;
    }
    const backupIndex = process.argv.indexOf('--backup-journal');
    if (backupIndex >= 0) {
      await local.exportJournal(process.argv[backupIndex + 1] || '');
      console.log('Created a consistent protected SQLite journal backup.'); return;
    }
    for (const [flag, operation] of [['--resume-restore', 'restore/apply-tombstones'], ['--cancel-preparing-restore', 'restore/cancel-preparing']]) {
      const index = process.argv.indexOf(flag);
      if (index < 0) continue;
      const sessionId = process.argv[index + 1];
      if (!/^[a-f0-9-]{36}$/i.test(sessionId || '')) throw Error('A valid restore session UUID is required.');
      await local.call(operation, { sessionId });
      if (operation === 'restore/apply-tombstones') await local.call('restore/end', { sessionId, success: true });
      console.log('Restore session verified and closed.'); return;
    }
    const infra = new DestructionInfrastructure(config, local);
    if (infra.provider() === 'local') {
      const reasons = await local.diagnostics();
      if (reasons.length) { for (const reason of reasons) console.error(`NOT READY: ${reason}`); process.exitCode = 1; }
      else console.log('READY: direct storage, durable journal, SMTP, scanner, DB protections and configured active backup targets verified.');
    } else if (!await infra.health()) { console.error('NOT READY: gateway provider or DESTRUCTION_ENABLED.'); process.exitCode = 1; }
    else console.log('READY: infrastructure gateway verified.');
    console.log(`DESTRUCTION_ENABLED=${process.env.DESTRUCTION_ENABLED === 'true' ? 'true' : 'false'} (not modified)`);
  } finally { local.onModuleDestroy(); await ds.destroy(); }
}
main().catch(error => { console.error(error.getResponse?.()?.message || error.message); process.exitCode = 1; });
