// Operator-only command: inspect gateway receipts and resolve the failure BEFORE invoking.
require('dotenv').config();
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { randomUUID } = require('node:crypto');
const config = require('../dist/config/typeorm.config').default;
const { DestructionRequest, DestructionJob } = require('../dist/entities/destruction.entity');
const { User } = require('../dist/entities/user.entity');
const { AuditLog } = require('../dist/entities/audit-log.entity');
async function main() {
  const args = process.argv.slice(2);
  const get = name => args[args.indexOf(name) + 1];
  const requestId = get('--request'), actorId = get('--actor'), reason = get('--reason');
  if (!args.includes('--apply') || !args.includes('--request') || !args.includes('--actor') || !args.includes('--reason')
    || !/^[a-f0-9-]{36}$/i.test(requestId || '') || !/^[a-f0-9-]{36}$/i.test(actorId || '') || !reason?.trim() || reason.length > 4000)
    throw Error('Usage: node scripts/retry-destruction.cjs --request <uuid> --actor <admin-uuid> --reason "operational resolution" --apply');
  const ds = new DataSource({ ...config(), synchronize: false, logging: false });
  await ds.initialize();
  try {
    await ds.transaction('READ COMMITTED', async m => {
      const actor = await m.findOneBy(User, { id: actorId });
      if (!actor?.isActive || actor.role !== 'admin') throw Error('An active admin actor is required');
      const request = await m.findOne(DestructionRequest, { where: { id: requestId }, lock: { mode: 'pessimistic_write' } });
      const job = await m.findOne(DestructionJob, { where: { requestId }, lock: { mode: 'pessimistic_write' } });
      if (!request || request.status !== 'failed' || !job || job.status !== 'failed') throw Error('Only a failed request/job can be requeued');
      const [clock] = await m.query('SELECT UTC_TIMESTAMP(3) AS now');
      const now = clock.now;
      // Preserve execute_after, manifests, object receipts, OTP/approvals, destroyed items and backup tombstones.
      request.status = 'scheduled'; request.version++; request.failureReason = null;
      job.status = 'scheduled'; job.leaseOwner = null; job.leaseExpiry = null;
      await m.save(DestructionRequest, request); await m.save(DestructionJob, job);
      await m.save(AuditLog, m.create(AuditLog, { id: randomUUID(), actor: { id: actorId }, action: 'destruction', createdAt: now,
        metadata: { requestId, description: `Vận hành đã cho thử lại sau kiểm tra: ${reason.trim()}`, oldStatus: 'failed', newStatus: 'scheduled',
          digest: request.digest, version: request.version, result: 'success' } }));
    });
    console.log('Requeued failed destruction request with checkpoints preserved:', requestId);
  } finally { await ds.destroy(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
