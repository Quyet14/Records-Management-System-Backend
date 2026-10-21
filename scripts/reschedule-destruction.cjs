// Operator command: preview by default; --apply updates only an unstarted scheduled job.
require('reflect-metadata');
const { DestructionService } = require('../dist/destruction/destruction.service');
const { approvalsValid, WAIT_MS } = require('../dist/destruction/destruction.rules');
const { DestructionRequest: Request, DestructionJob: Job, DestructionApproval: Approval } = require('../dist/entities/destruction.entity');

async function reschedule(manager, requestId, apply = false) {
  const lock = apply ? { mode: 'pessimistic_write' } : undefined;
  const request = await manager.findOne(Request, { where: { id: requestId }, ...(lock ? { lock } : {}) });
  const job = await manager.findOne(Job, { where: { requestId }, ...(lock ? { lock } : {}) });
  if (!request || request.status !== 'scheduled' || !job || job.status !== 'scheduled'
    || job.leaseOwner || job.leaseExpiry || !request.executeAfter)
    throw Error('Only an unstarted scheduled request/job can be rescheduled.');
  const service = new DestructionService({ manager }, {});
  const now = await service.now(manager);
  const { docs } = await service.checkItems(manager, request, now);
  if (docs.some(doc => doc.destructionStartedAt)) throw Error('Destruction has already started.');
  const approvals = await manager.findBy(Approval, { requestId });
  if (!approvalsValid(request, docs, approvals, await service.approvalReviewers(manager, approvals)))
    throw Error('Approval roles, scope or request binding are no longer valid.');
  const approvedTimes = approvals.map(a => new Date(a.approvedAt).getTime());
  if (approvedTimes.some(time => !Number.isFinite(time) || time > now.getTime())) throw Error('Invalid approval time.');
  const executeAfter = new Date(Math.max(...approvedTimes) + WAIT_MS);
  const oldExecuteAfter = new Date(request.executeAfter);
  if (!Number.isFinite(oldExecuteAfter.getTime()) || executeAfter > oldExecuteAfter)
    throw Error('This command only shortens a previous waiting period.');
  const changed = executeAfter.getTime() !== oldExecuteAfter.getTime();
  if (apply && changed) {
    request.executeAfter = executeAfter; request.version++;
    job.runAt = executeAfter;
    await manager.save(Request, request);
    await manager.save(Job, job);
    await service.audit(manager, null, request,
      `Vận hành đổi lịch hủy theo thời gian chờ hiện hành: ${oldExecuteAfter.toISOString()} -> ${executeAfter.toISOString()}`, 'scheduled');
  }
  return { requestId, oldExecuteAfter: oldExecuteAfter.toISOString(), executeAfter: executeAfter.toISOString(),
    applied: apply && changed, due: executeAfter <= now };
}

async function main() {
  const args = process.argv.slice(2);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0] || '')
    || args.length > 2 || (args.length === 2 && args[1] !== '--apply'))
    throw Error('Usage: node scripts/reschedule-destruction.cjs <request-uuid> [--apply]');
  require('dotenv').config();
  const { DataSource } = require('typeorm');
  const database = require('../dist/config/typeorm.config').default;
  const ds = new DataSource({ ...database(), synchronize: false, migrationsRun: false, logging: false });
  await ds.initialize();
  try {
    const result = await ds.transaction('READ COMMITTED', manager => reschedule(manager, args[0], args.includes('--apply')));
    console.log(JSON.stringify(result, null, 2));
    if (!args.includes('--apply')) console.log('Preview only. Dates are UTC. Use --apply to update the inspected request and job.');
    else console.log('Dates are UTC. No file was deleted by this command; the worker uses the updated schedule.');
  } finally { await ds.destroy(); }
}
module.exports = { reschedule };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
