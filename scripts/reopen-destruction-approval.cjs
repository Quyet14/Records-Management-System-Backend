// Restore the OTP workflow, never synthesize/delete approvals or mark content destroyed.
require('reflect-metadata');
const { DestructionService } = require('../dist/destruction/destruction.service');
const { User } = require('../dist/entities/user.entity');
const E = require('../dist/entities/destruction.entity');

function assertNoDeletionEvidence(journal, requestId) {
  const manifests = new Set([...journal.iterate('manifest')].filter(row => row.requestId === requestId).map(row => row.id));
  if ([...journal.iterate('exclusion')].some(row => row.requestId === requestId)
    || [...journal.iterate('object')].some(row => manifests.has(row.manifestId))
    || [...journal.iterate('deletion')].some(row => manifests.has(row.manifestId)))
    throw Error('Journal contains exclusion/deletion evidence; a separate reconciliation is required.');
}

async function reopen(manager, requestId, actorId, reason, apply = false) {
  const request = await manager.findOne(E.DestructionRequest, { where: { id: requestId }, lock: { mode: 'pessimistic_write' } });
  const job = await manager.findOne(E.DestructionJob, { where: { requestId }, lock: { mode: 'pessimistic_write' } });
  const actor = await manager.findOneBy(User, { id: actorId });
  if (!actor?.isActive || actor.role !== 'admin' || !reason?.trim() || reason.length > 4000) throw Error('An active admin and a reason are required.');
  if (!request || request.status !== 'failed' || request.destroyedAt || request.completedAt
    || !job || job.status !== 'failed' || job.leaseOwner || job.leaseExpiry || job.checkpoint)
    throw Error('Only a failed request/job without execution checkpoint or lease can be reopened.');
  if (await manager.countBy(E.DestructionApproval, { requestId })) throw Error('Existing approvals must be preserved; this command only handles zero recorded approvals.');
  if (await manager.countBy(E.DestructionBackupDisposition, { requestId })) throw Error('Backup tombstones already exist.');
  const service = new DestructionService({ manager }, {});
  const { items, docs } = await service.checkItems(manager, request, await service.now(manager));
  if (items.some(item => item.status !== 'pending' || item.executionResult || item.destroyedAt || item.checksumAtDestruction)
    || docs.some(doc => doc.status === 'destroyed' || doc.destroyedAt)) throw Error('Content has already been prepared or destroyed.');
  if (apply) {
    request.status = 'pending'; request.version++; request.executeAfter = null; request.failureReason = null;
    job.status = 'cancelled'; job.lastError = null;
    await manager.save(E.DestructionRequest, request); await manager.save(E.DestructionJob, job);
    await service.audit(manager, actorId, request, `Vận hành mở lại bước duyệt OTP do không có lượt duyệt được lưu: ${reason.trim()}`, 'failed');
  }
  return { requestId, from: 'failed', to: 'pending', recordedApprovals: 0, documents: items.length,
    applied: apply, next: 'Review evidence and approve with a new OTP; the full waiting period starts after approval.' };
}

async function main() {
  const args = process.argv.slice(2), values = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--request', '--actor', '--reason', '--apply'].includes(key) || values.has(key)) throw Error('Invalid or repeated argument. Run one command per line.');
    values.set(key, key === '--apply' ? true : args[++i]);
  }
  const requestId = values.get('--request'), actorId = values.get('--actor'), reason = values.get('--reason'), apply = values.has('--apply');
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  if (!uuid(requestId) || !uuid(actorId) || !reason?.trim() || reason.length > 4000)
    throw Error('Usage: node scripts/reopen-destruction-approval.cjs --request <uuid> --actor <admin-uuid> --reason "reason" [--apply]');
  require('dotenv').config();
  const fs = require('node:fs'), path = require('node:path');
  const { DataSource } = require('typeorm'), { ConfigService } = require('@nestjs/config');
  const database = require('../dist/config/typeorm.config').default;
  const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
  const { LocalDestructionJournal } = require('../dist/destruction/local-storage');
  const { DestructionInfrastructure } = require('../dist/destruction/destruction.infrastructure');
  const config = new ConfigService(process.env);
  if (new DestructionInfrastructure(config).provider() !== 'local') throw Error('Only the local provider is supported.');
  const ds = new DataSource({ ...database(), synchronize: false, migrationsRun: false, logging: false });
  await ds.initialize();
  const local = new LocalDestructionInfrastructure(config, ds);
  try {
    const result = await local.exclusive(async () => {
      if (local.maintenance()) throw Error('Restore maintenance is active.');
      const settings = local.settings();
      if (!fs.existsSync(path.join(settings.state, 'destruction.sqlite'))) throw Error('Original destruction journal is missing.');
      local.sessions(); // Validate the existing journal's deployment identity before inspecting it.
      const journal = new LocalDestructionJournal(settings.state);
      try { assertNoDeletionEvidence(journal, requestId); } finally { journal.close(); }
      return ds.transaction('READ COMMITTED', manager => reopen(manager, requestId, actorId, reason, apply));
    });
    console.log(JSON.stringify(result, null, 2));
    if (!apply) console.log('PLAN ONLY. Add --apply to reopen OTP review; no approval is created by this command.');
  } finally { local.onModuleDestroy(); await ds.destroy(); }
}
module.exports = { reopen, assertNoDeletionEvidence };
if (require.main === module) main().catch(error => { console.error(error.getResponse?.()?.message || (error.name === 'QueryFailedError' ? 'Database operation failed.' : error.message)); process.exitCode = 1; });
