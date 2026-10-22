// Compile real TypeORM MySQL queries, execute the read queries against mixed-department SQLite fixtures.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DataSource, QueryResult } = require('typeorm');
const { Reflector } = require('@nestjs/core');
const { StatsService } = require('../dist/stats/stats.service');
const { StatsController } = require('../dist/stats/stats.controller');
const { RetentionService } = require('../dist/retention/retention.service');
const { RetentionController } = require('../dist/retention/retention.controller');
const { SystemService } = require('../dist/system/system.service');
const { SystemController } = require('../dist/system/system.controller');
const { RolesGuard } = require('../dist/common/guards/roles.guard');
const { reportDepartment } = require('../dist/common/report-scope');
const { JwtStrategy } = require('../dist/auth/jwt.strategy');
const { Document } = require('../dist/entities/document.entity');
const { User } = require('../dist/entities/user.entity');
const { Department } = require('../dist/entities/department.entity');
const { DocumentType } = require('../dist/entities/document-type.entity');
const { AuditLog } = require('../dist/entities/audit-log.entity');

async function main() {
  const entities = fs.readdirSync(path.join(__dirname, '../dist/entities')).filter(n => n.endsWith('.entity.js'))
    .flatMap(n => Object.values(require('../dist/entities/' + n)).filter(v => typeof v === 'function'));
  const ds = new DataSource({ type: 'mysql', database: 'offline', entities }); await ds.buildMetadatas();
  const sqlite = new DatabaseSync(':memory:');
  sqlite.function('YEAR', value => value ? Number(String(value).slice(0, 4)) : null);
  sqlite.function('MONTH', value => value ? Number(String(value).slice(5, 7)) : null);
  let queries = 0;
  const dateColumns = new Set(ds.entityMetadatas.flatMap(meta => meta.columns
    .filter(col => [Date, 'datetime', 'timestamp'].includes(col.type)).map(col => col.databaseName)));
  const originalRunner = ds.createQueryRunner.bind(ds);
  ds.createQueryRunner = () => {
    const runner = originalRunner();
    runner.release = async () => {};
    runner.query = async (sql, params = [], structured = false) => {
      queries++;
      const values = params.map(value => value instanceof Date ? value.toISOString().replace('T', ' ').replace('Z', '')
        : typeof value === 'boolean' ? Number(value) : value);
      const rows = sqlite.prepare(sql).all(...values).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
        [key, typeof value === 'string' && [...dateColumns].some(name => key === name || key.endsWith('_' + name)) ? new Date(value) : value])));
      if (!structured) return rows;
      const result = new QueryResult(); result.records = rows; result.raw = rows; result.affected = rows.length; return result;
    };
    return runner;
  };
  const tables = [Document, User, Department, DocumentType, AuditLog];
  for (const entity of tables) {
    const meta = ds.getMetadata(entity);
    const columns = meta.columns.map(col => `\`${col.databaseName}\` ${['int', 'bigint', 'boolean', Number, Boolean].includes(col.type) ? 'INTEGER' : 'TEXT'}`);
    sqlite.exec(`CREATE TABLE \`${meta.tableName}\` (${columns.join(',')})`);
  }
  const insert = (table, row) => sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).map(k => '`' + k + '`').join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  insert('departments', { id: 'a', name: 'Khoa A' }); insert('departments', { id: 'b', name: 'Khoa B' });
  for (const dept of ['a', 'b']) {
    insert('users', { id: 'user-' + dept, full_name: 'User ' + dept, email: dept + '@test.invalid', department_id: dept, role: 'user', is_active: 1 });
    insert('document_types', { id: 'type-' + dept, name: 'Type ' + dept, code: dept, retention_years: 5, is_permanent: 0 });
  }
  const year = new Date().getUTCFullYear(), future = new Date(Date.now() + 5 * 86400000).toISOString();
  const docs = [
    { id: 'a1', dept: 'a', bytes: 10, status: 'stored', type: 'type-a', date: '2020-01-01', created: `${year}-01-10`, hash: null },
    { id: 'a2', dept: 'a', bytes: 20, status: 'pending', type: null, date: null, created: `${year}-02-10`, hash: 'a'.repeat(64) },
    { id: 'b1', dept: 'b', bytes: 900, status: 'stored', type: 'type-b', date: '2020-01-01', created: `${year}-01-10`, hash: '' },
    { id: 'b2', dept: 'b', bytes: 700, status: 'stored', type: 'type-b', date: null, created: '2020-01-10', hash: null },
  ];
  for (const doc of docs) insert('documents', { id: doc.id, title: doc.id, original_filename: doc.id + '.pdf', department_id: doc.dept,
    uploader_id: 'user-' + doc.dept, document_type_id: doc.type, file_size_bytes: doc.bytes, status: doc.status,
    classification_value: doc.dept === 'a' ? 'timed' : 'permanent', review_status: 'not_started', document_date: doc.date,
    created_at: doc.created, expires_at: future, sha256_checksum: doc.hash });
  for (const row of [
    { id: 'aa', document_id: 'a1', action: 'approve', metadata: JSON.stringify({ archivePath: '/private/server' }) },
    { id: 'ar', document_id: 'a1', action: 'reject', metadata: JSON.stringify({ reason: 'Needs review', secret: 'hidden' }) },
    { id: 'ab', document_id: 'b1', action: 'approve', metadata: '{}' },
    { id: 'au', document_id: 'a1', action: 'upload', metadata: '{}' },
    { id: 'al', document_id: null, action: 'login', metadata: '{}' },
  ]) insert('audit_logs', { ...row, actor_id: 'user-a', created_at: '2026-01-01' });
  const stats = new StatsService(ds.getRepository(Document), ds.getRepository(User), ds.getRepository(Department), ds.getRepository(DocumentType));
  const retention = new RetentionService(ds.getRepository(Document));
  // Do not invoke the SystemService constructor: it creates the deployment backup directory.
  const system = Object.assign(Object.create(SystemService.prototype), { docRepo: ds.getRepository(Document), auditRepo: ds.getRepository(AuditLog) });
  const statsController = new StatsController(stats), retentionController = new RetentionController(retention), systemController = new SystemController(system);
  const head = { role: 'department_head', departmentId: 'a' }, admin = { role: 'admin' };
  try {
    const overview = await statsController.getOverview(head);
    assert.equal(overview.totalDocuments, 2); assert.equal(overview.totalUsers, 1); assert.equal(overview.totalDepartments, 1);
    assert.equal(overview.storedSizeBytes, 10); assert.equal(overview.byStatus.reduce((n, r) => n + r.count, 0), 2);
    assert.equal((await statsController.getOverview(admin)).totalDocuments, 4);
    assert.equal((await statsController.getOverview({ ...head, departmentId: 'b' })).storedSizeBytes, 1600);
    assert.deepEqual((await statsController.getByDepartment(head)).map(r => r.departmentId), ['a']);
    assert.equal((await statsController.getByYear(head, String(year))).monthly.reduce((n, r) => n + r.totalDocuments, 0), 2);
    assert.equal((await statsController.getStorageGrowth(head)).at(-1).cumulativeBytes, 10);
    assert.deepEqual((await statsController.getTopUploaders(head)).map(r => r.userId), ['user-a']);
    const types = await statsController.getByDocumentType(head);
    assert.equal(types.unclassifiedCount, 1); assert(types.byType.every(r => r.typeId === null || r.typeId === 'type-a'));
    assert.deepEqual((await statsController.getByClassification(head)).map(r => r.classificationValue), ['timed']);
    assert.equal((await statsController.getReviewProgress(head)).totalOldDocuments, 1);
    assert.deepEqual((await statsController.getExpiringSoon(head)).data.map(r => r.id), ['a1']);
    assert.deepEqual((await retentionController.getExpiring(head)).map(r => r.id), ['a1']);
    assert.deepEqual((await retentionController.getPendingReview(head)).data.map(r => r.id), ['a1']);
    assert.equal((await retentionController.getReviewSummary(head)).totalOldDocuments, 1);
    assert.equal((await retentionController.getReviewSummary(admin)).totalOldDocuments, 3);
    const missing = await systemController.getMissingChecksums(head);
    assert.deepEqual(missing.data.map(r => r.id), ['a1']); assert.equal(missing.total, 1);
    const audit = await systemController.getAuditLogs(head);
    assert.deepEqual(audit.data.map(r => r.id).sort(), ['aa', 'ar']);
    assert.deepEqual(audit.data.find(r => r.id === 'aa').metadata, {});
    assert.deepEqual(audit.data.find(r => r.id === 'ar').metadata, { reason: 'Needs review' });
    assert.equal((await systemController.getAuditLogs(head, undefined, undefined, 'b1')).total, 0);
    assert.equal((await systemController.getAuditLogs(admin)).total, 5);
    assert.equal((await systemController.getMissingChecksums(admin)).total, 3);
    const before = queries;
    for (const actor of [{ role: 'department_head' }, { role: 'department_head', departmentId: ' ' }, { role: 'user', departmentId: 'a' }]) {
      for (const invoke of [() => statsController.getOverview(actor), () => retentionController.getReviewSummary(actor),
        () => systemController.getMissingChecksums(actor), () => systemController.getAuditLogs(actor)])
        assert.throws(invoke, e => e.getStatus?.() === 403);
    }
    assert.equal(queries, before, 'No report query may execute without an authorized department.');
    await assert.rejects(() => statsController.getByYear(head, 'bad'), e => e.getStatus?.() === 400);
    await assert.rejects(() => systemController.getAuditLogs(head, undefined, undefined, undefined, '0'), e => e.getStatus?.() === 400);
    const guard = new RolesGuard(new Reflector());
    const allowed = (Controller, method, actor) => guard.canActivate({ getClass: () => Controller,
      getHandler: () => Controller.prototype[method], switchToHttp: () => ({ getRequest: () => ({ user: actor }) }) });
    for (const [Controller, methods] of [[StatsController, ['getOverview', 'getByYear']],
      [RetentionController, ['getExpiring', 'getPendingReview', 'getReviewSummary']], [SystemController, ['getMissingChecksums', 'getAuditLogs']]]) {
      for (const method of methods) { assert(allowed(Controller, method, head)); assert(!allowed(Controller, method, { role: 'user' })); }
    }
    for (const method of ['getHealth', 'getStatus', 'verifyChecksums', 'runBackup', 'testRestore']) assert(!allowed(SystemController, method, head));
    for (const method of ['legalHold', 'updateReviewStatus']) assert(!allowed(RetentionController, method, head));
    assert.equal(reportDepartment(admin), undefined);
    const strategy = Object.assign(Object.create(JwtStrategy.prototype), {
      usersRepo: { findOne: async () => ({ id: 'head', role: 'department_head', department: { id: 'a' }, isActive: true, permissions: [] }) },
      sessionsRepo: { findOne: async () => ({ id: 'session', createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 3600000) }), update: async () => {} },
    });
    const refreshedActor = await strategy.validate({ sub: 'head', sid: 'session', role: 'admin', departmentId: 'b' });
    assert.equal(refreshedActor.role, 'department_head'); assert.equal(refreshedActor.departmentId, 'a');
    assert.equal((await statsController.getOverview(refreshedActor)).storedSizeBytes, 10);
    console.log('PASS: actual aggregate/list SQL over two departments; null dates/OR boundaries, scoped totals/users/types/checksums/audits, metadata redaction, unassigned denial before queries and admin-only operations.');
    console.log('LIMIT: MySQL SQL is executed on SQLite fixtures; live JWT/HTTP and MySQL deployment checks remain.');
  } finally { sqlite.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
