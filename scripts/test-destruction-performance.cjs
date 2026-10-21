// Offline query-count and concurrency checks, not a live-server latency benchmark.
require('reflect-metadata');
process.env.ARCHIVE_ALLOW_LEGACY_READ = 'true';
const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { DestructionService } = require('../dist/destruction/destruction.service');
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { User } = require('../dist/entities/user.entity');
const { DestructionRequest, DestructionApproval } = require('../dist/entities/destruction.entity');

async function checkList(size) {
  const requests = Array.from({ length: size }, (_, i) => ({ id: `request-${i}`, createdBy: `user-${i % 3}`,
    code: `HUY-${i}`, decisionNumber: `${i}`, status: 'pending', requiredApprovals: 2, executeAfter: null }));
  let queries = 0;
  const qb = {
    orderBy() { return this; }, addOrderBy() { return this; }, skip() { return this; }, take() { return this; },
    async getManyAndCount() { queries += 2; return [requests, requests.length]; },
  };
  const db = {
    manager: {
      async find(entity, options) {
        queries++;
        assert.equal(entity, User);
        assert.deepEqual(options.select, { id: true, fullName: true });
        return [0, 1, 2].map(i => ({ id: `user-${i}`, fullName: `Reviewer ${i}` }));
      },
      findOneBy() { throw Error('Per-row name query is forbidden'); },
      countBy() { throw Error('Per-row count query is forbidden'); },
    },
    getRepository(entity) {
      if (entity === DestructionRequest) return { createQueryBuilder: () => qb };
      assert.equal(entity, DestructionApproval);
      const counts = {
        select() { return this; }, addSelect() { return this; }, groupBy() { return this; },
        where(_sql, params) { assert.deepEqual(params.requestIds, requests.map(r => r.id)); return this; },
        async getRawMany() { queries++; return requests.filter((_, i) => i % 2).map(r => ({ requestId: r.id, count: '1' })); },
      };
      return { createQueryBuilder: () => counts };
    },
  };
  const result = await new DestructionService(db, {}).list({ pageSize: 100 }, { id: 'admin', role: 'admin' });
  assert.equal(result.items.length, size);
  assert.equal(result.total, size);
  result.items.forEach((item, i) => {
    assert.equal(item.createdBy.fullName, `Reviewer ${i % 3}`);
    assert.equal(item.approvalCount, i % 2);
    assert.equal(item.id, requests[i].id);
    assert.equal(item.requiredApprovals, 2);
  });
  assert.equal(queries, size ? 4 : 2);
}

async function checkHealth() {
  const local = new LocalDestructionInfrastructure(new ConfigService({}), {});
  let checks = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  local.maintenance = () => false;
  local.settings = () => ({ version: 'test-only', policyTargets: [] });
  local.diagnostics = async () => { checks++; await gate; return []; };
  const pending = Array.from({ length: 20 }, () => local.call('health', {}));
  assert.equal(checks, 1, 'Concurrent readers must share one readiness check');
  release();
  assert((await Promise.all(pending)).every(result => result.ready));
  await local.call('health', {});
  assert.equal(checks, 1, 'A valid cached result must be reused');
  local.healthCache.expires = Date.now() - 1;
  await local.call('health', {});
  assert.equal(checks, 2);
  local.maintenance = () => true;
  assert.equal((await local.call('health', {})).ready, false, 'Maintenance overrides cached readiness');
  local.maintenance = () => false;
  local.healthCache = undefined;
  local.diagnostics = async () => { throw Error('probe failed'); };
  await assert.rejects(() => local.call('health', {}), /probe failed/);
  local.diagnostics = async () => ['test unavailable'];
  assert.equal((await local.call('health', {})).ready, false, 'A failed promise must not poison subsequent checks');
}

async function checkParallelProbes() {
  let releaseSmtp, scannerStarted = false, databaseStarted = false;
  const smtpGate = new Promise(resolve => { releaseSmtp = resolve; });
  const local = new LocalDestructionInfrastructure(new ConfigService({ DESTRUCTION_OTP_SECRET: 'x'.repeat(32) }), {
    manager: { query: async sql => {
      databaseStarted = true;
      return sql.includes('max_allowed_packet') ? [{ bytes: 64 * 1024 * 1024 }] : [];
    } },
  });
  local.settings = () => { throw Error('No real filesystem used in this test'); };
  local.maintenance = () => false;
  local.mailer = () => ({ verify: () => smtpGate });
  local.command = async () => { scannerStarted = true; };
  const pending = local.diagnostics();
  assert.equal(scannerStarted, true, 'Scanner check must not wait for SMTP');
  assert.equal(databaseStarted, true, 'Database check must not wait for SMTP');
  releaseSmtp();
  await pending;
}

(async () => {
  for (const count of [0, 20, 100]) await checkList(count);
  await checkHealth();
  await checkParallelProbes();
  console.log('PASS: list uses four queries for 20/100 rows; 20 concurrent health reads share one check; caching and maintenance remain enforced.');
})().catch(error => { console.error(error); process.exitCode = 1; });
