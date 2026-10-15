// npm run build && node scripts/test-document-security.cjs
// No application server/database is used. SQLite SQL parity checks run on Node 22+.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DataSource } = require('typeorm');
const security = require('../dist/common/document-security');
const { DocumentsService } = require('../dist/documents/documents.service');
const { DocumentAccessGuard } = require('../dist/common/guards/document-access.guard');
const { ViewRequestsService } = require('../dist/view-requests/view-requests.service');
const { ExportService } = require('../dist/export/export.service');
const { TagsService } = require('../dist/tags/tags.service');
const { NotificationsService } = require('../dist/notifications/notifications.service');
const { Document } = require('../dist/entities/document.entity');
const { Notification } = require('../dist/entities/notification.entity');
const { ViewRequest } = require('../dist/entities/view-request.entity');

const actors = [
  { id: 'admin', role: 'admin' },
  { id: 'head-a', role: 'department_head', departmentId: 'a' },
  { id: 'head-b', role: 'department_head', departmentId: 'b' },
  { id: 'head-none', role: 'department_head' },
  { id: 'reader', role: 'user', departmentId: 'a', permissions: ['view_department_documents', 'request_document_view'] },
  { id: 'delegate', role: 'user', departmentId: 'a', permissions: ['approve_documents'] },
  { id: 'owner', role: 'user', departmentId: 'a' },
];
const groups = [
  { rank: 0, values: [null, '', 'normal', 'Thường', ' thuong ', 'NONE'] },
  { rank: 1, values: ['confidential', 'Mật', 'mat', ' MẬT '] },
  { rank: 2, values: ['secret', 'Tối mật', 'toi_mat', 'highly_confidential'] },
  { rank: 3, values: ['top_secret', 'Tuyệt mật', 'tuyet_mat'] },
  { rank: 4, values: ['unexpected', 'mát', '0'] },
];
function doc(level, departmentId = 'a') {
  return {
    id: 'document', title: 'Test', securityLevel: level,
    status: 'pending', visibility: 'public', department: departmentId ? { id: departmentId } : null,
    uploader: { id: 'owner', email: 'owner@example.test' }, tags: [],
    file: { storageKey: __filename }, storagePath: __filename, sha256Checksum: 'hash',
  };
}
function expected(rank, departmentId, actor) {
  return actor.role === 'admin' || actor.id === 'owner' || rank === 0 || (
    rank === 1 && actor.role === 'department_head' && !!actor.departmentId && actor.departmentId === departmentId
  );
}
function context(document) {
  let saved = 0;
  return Object.assign(Object.create(DocumentsService.prototype), {
    docsRepo: { findOne: async () => document, save: async value => { saved++; return value; } },
    userRepo: { findOne: async () => null },
    retentionService: { computeAndSaveExpiry: async () => {} },
    accessLogsRepo: { create: value => value, save: async value => value },
    appendDayLog() {}, log: async () => {}, eventEmitter: { emit() {} },
    saved: () => saved,
  });
}
async function denied(operation) {
  await assert.rejects(operation, error => error.getStatus?.() === 403);
}

async function main() {
  let checks = 0;
  for (const { rank, values } of groups) for (const value of values) {
    if (rank < 4) assert.equal(security.normalizeDocumentSecurityLevel(value), ['normal', 'confidential', 'secret', 'top_secret'][rank]);
    else assert.throws(() => security.normalizeDocumentSecurityLevel(value), error => error.getStatus() === 400);
    for (const dept of ['a', 'b', undefined]) for (const actor of actors) {
      const record = doc(value, dept);
      // Passing undefined selects the default parameter; explicitly remove the department.
      if (!dept) record.department = null;
      const allowed = expected(rank, dept, actor);
      assert.equal(security.canAccessDocumentSecurity(record, actor), allowed);
      if (!allowed) {
        await denied(context(record).getDetail(record.id, actor));
        await denied(context(record).getFileForDownload(record.id, actor));
        await denied(context(record).getFileForView(record, actor));
        const view = { docsRepo: { findOne: async () => record } };
        await denied(ViewRequestsService.prototype.getViewStatus.call(view, record.id, actor));
        // No request repository: degree restrictions must be checked before old approved requests.
        const guard = new DocumentAccessGuard(view.docsRepo, {});
        await denied(guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ user: actor, params: { id: record.id } }) }) }));
      } else if (actor.role === 'admin' || actor.id === 'owner' || (
        (actor.role === 'department_head' || actor.id === 'delegate') && actor.departmentId && actor.departmentId === dept
      )) {
        assert.equal((await context(record).getDetail(record.id, actor)).id, record.id);
      }
      const mayReview = allowed && (actor.role === 'admin' || (
        !!actor.departmentId && actor.departmentId === dept && (actor.role === 'department_head' || actor.id === 'delegate')
      ));
      for (const action of ['approve', 'reject']) {
        const service = context({ ...record });
        const operation = service[action](record.id, actor, 'test');
        if (mayReview) {
          const result = await operation;
          assert.equal(result.status, action === 'approve' ? 'stored' : 'rejected');
        } else {
          await denied(operation);
          assert.equal(service.saved(), 0);
        }
      }
      // Notifications must not reveal a restricted document title via SSE.
      let notifications = 0;
      const recipient = { ...actor, department: actor.departmentId ? { id: actor.departmentId } : null };
      const noti = Object.assign(Object.create(NotificationsService.prototype), {
        docRepo: { findOne: async () => record }, userRepo: { findOne: async () => recipient },
        notiRepo: { create: value => value, save: async value => { notifications++; return value; } }, pushSse() {},
      });
      await noti.saveAndPush(actor.id, 'document_pending', 'Title', 'Secret message', record.id);
      assert.equal(notifications, allowed ? 1 : 0);
      checks++;
    }
  }

  const head = actors[1];
  const admin = actors[0];
  await denied(context(doc('confidential')).updateDocument('document', { securityLevel: 'normal' }, head));
  assert.equal((await context(doc('confidential')).updateDocument('document', { securityLevel: 'normal' }, admin)).securityLevel, 'normal');
  assert.equal((await context(doc('normal')).updateDocument('document', { securityLevel: 'Mật' }, head)).securityLevel, 'confidential');
  await denied(context(doc('confidential')).updateDocument('document', { departmentId: 'b' }, head));
  await denied(context(doc('top_secret')).updateDocument('document', { title: 'Overwrite' }, head));
  await assert.rejects(context(doc('normal')).upload({}, { title: 'Invalid', securityLevel: 'invalid' }, actors[4]), error => error.getStatus() === 400);
  await assert.rejects(context(null).uploadMultiple([], 'a', actors[4], 'invalid'), error => error.getStatus() === 400);

  // A previously approved view request must not grant access after reclassification.
  const restricted = doc('top_secret');
  const oldRequest = { id: 'request', status: 'approved', document: restricted,
    requester: { id: 'reader' }, accessExpiresAt: new Date(Date.now() + 60000) };
  const requests = Object.assign(Object.create(ViewRequestsService.prototype), {
    docsRepo: { findOne: async () => restricted },
    viewRequestsRepo: { findOne: async () => oldRequest, find: async () => [oldRequest] },
  });
  await denied(requests.create(restricted.id, {}, actors[4]));
  await denied(requests.extend('request', {}, actors[4]));
  await denied(requests.getViewStatus(restricted.id, actors[4]));
  await denied(requests.approve('request', { approvedDuration: 1 }, admin));

  const entities = fs.readdirSync(path.join(__dirname, '../dist/entities'))
    .filter(name => name.endsWith('.entity.js'))
    .flatMap(name => Object.values(require('../dist/entities/' + name)).filter(value => typeof value === 'function'));
  const ds = new DataSource({ type: 'mysql', database: 'offline_test', entities });
  await ds.buildMetadatas();

  // Check that each collection/export path applies the SQL restriction before execution.
  for (const actor of actors.filter(a => a.role !== 'user' || a.id === 'delegate')) {
    if (actor.id === 'head-none') continue;
    const captures = [];
    function repo(entity) {
      return { createQueryBuilder(alias) {
        const qb = ds.getRepository(entity).createQueryBuilder(alias);
        const capture = () => captures.push(qb.getParameters());
        qb.getMany = async () => { capture(); return []; };
        qb.getCount = async () => { capture(); return 0; };
        qb.getManyAndCount = async () => { capture(); return [[], 0]; };
        return qb;
      } };
    }
    const docs = Object.assign(Object.create(DocumentsService.prototype), { docsRepo: repo(Document) });
    await docs.search({}, actor);
    await docs.findPendingQueue(actor);
    await docs.buildArchiveQuery(actor).getMany();
    const exports = Object.assign(Object.create(ExportService.prototype), { docRepo: repo(Document) });
    await exports.getDocs({}, actor);
    const tags = Object.assign(Object.create(TagsService.prototype), { docRepo: repo(Document) });
    await tags.findDocumentsByTagName('test', actor);
    if (actor.role !== 'user') {
      const viewRequests = Object.assign(Object.create(ViewRequestsService.prototype), { viewRequestsRepo: repo(ViewRequest) });
      await viewRequests.findAll({}, actor);
    }
    const notifications = Object.assign(Object.create(NotificationsService.prototype), { notiRepo: repo(Notification) });
    await notifications.getMyNotifications(actor);
    await notifications.countUnread(actor);
    for (const parameters of captures) {
      assert.equal('securityUserId' in parameters, actor.role !== 'admin');
      if (actor.role !== 'admin') assert.equal(parameters.securityUserId, actor.id);
      checks++;
    }
  }

  let sqlChecks = 0;
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch {}
  if (sqlite) {
    const db = new sqlite.DatabaseSync(':memory:');
    db.function('LOWER', value => value == null ? null : value.toLowerCase());
    db.exec('CREATE TABLE documents (id TEXT, security_level TEXT, uploader_id TEXT, department_id TEXT)');
    const insert = db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?)');
    const cases = [];
    for (const group of groups) for (const value of group.values) for (const dept of ['a', 'b', null]) {
      const id = String(cases.length);
      cases.push({ id, rank: group.rank, dept });
      insert.run(id, value, 'owner', dept);
    }
    for (const actor of actors) {
      const qb = ds.getRepository(Document).createQueryBuilder('doc').select('doc.id');
      security.applyDocumentSecurityScope(qb, actor);
      const [mysqlSql, parameters] = qb.getQueryAndParameters();
      // SQLite's BINARY cast is numeric; use TEXT with binary collation for MySQL byte comparison semantics.
      const sql = mysqlSql.replace(/ AS BINARY\)/g, ' AS TEXT) COLLATE BINARY');
      const actual = db.prepare(sql).all(...parameters).map(row => row.doc_id).sort();
      const want = cases.filter(test => expected(test.rank, test.dept, actor)).map(test => test.id).sort();
      assert.deepEqual(actual, want, `SQL security scope mismatch for ${actor.id}`);
      sqlChecks += cases.length;
    }
    db.close();
  }
  console.log(`PASS: ${checks} security/access/API scope cases, classification changes, legacy request denial and notification checks.`);
  console.log(sqlite ? `PASS: ${sqlChecks} generated SQL filter parity checks (SQLite in memory; no live MySQL).` : 'SKIP: SQL execution parity checks require Node 22+ with node:sqlite.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
