// Run after npm run build. Uses repository stubs, never connects to a database.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { validate } = require('class-validator');
const { DataSource } = require('typeorm');
const fs = require('node:fs');
const { DocumentsService } = require('../dist/documents/documents.service');
const { UsersService } = require('../dist/users/users.service');
const { ViewRequestsService } = require('../dist/view-requests/view-requests.service');
const { canViewDepartmentDocument } = require('../dist/common/document-permissions');
const { DocumentAccessGuard } = require('../dist/common/guards/document-access.guard');
const { UpdateUserPermissionsDto } = require('../dist/users/dto/update-user-permissions.dto');
const { Document, DocumentStatus, DocumentVisibility } = require('../dist/entities/document.entity');
const { UserPermission } = require('../dist/entities/user.entity');

function document(departmentId) {
  return {
    id: 'document-1', department: departmentId ? { id: departmentId } : null,
    uploader: { id: 'owner', email: 'owner@example.test' },
    status: DocumentStatus.PENDING, visibility: DocumentVisibility.DEPARTMENT,
    file: { storageKey: 'unused.pdf' }, sha256Checksum: 'checksum',
  };
}

function service(doc) {
  return Object.assign(Object.create(DocumentsService.prototype), {
    getOrFail: async () => doc,
    docsRepo: { save: async value => value, findOne: async () => null },
    userRepo: { findOne: async () => null },
    appendDayLog() {}, log: async () => {}, eventEmitter: { emit() {} },
  });
}

async function main() {
  const entities = fs.readdirSync(require('node:path').join(__dirname, '../dist/entities'))
    .filter(name => name.endsWith('.entity.js'))
    .flatMap(name => Object.values(require('../dist/entities/' + name)).filter(value => typeof value === 'function'));
  const ds = new DataSource({ type: 'mysql', database: 'offline_test', entities });
  await ds.buildMetadatas();
  let checks = 0;
  for (const role of ['admin', 'department_head', 'user']) {
    for (const departmentId of ['dept-a', undefined]) {
      for (const permissions of [[], [UserPermission.APPROVE_DOCUMENTS]]) {
        const actor = { id: 'reviewer', role, departmentId, permissions };
        const reviewer = role === 'admin' || (!!departmentId && (role === 'department_head' || permissions.length > 0));
        for (const docDept of ['dept-a', 'dept-b', undefined]) {
          const allowed = role === 'admin' || (reviewer && docDept === departmentId);
          for (const action of ['approve', 'reject']) {
            const doc = document(docDept);
            const operation = service(doc)[action](doc.id, actor, 'Rejected in test');
            if (allowed) {
              const result = await operation;
              assert.equal(result.status, action === 'approve' ? DocumentStatus.STORED : DocumentStatus.REJECTED);
              if (action === 'approve') assert.equal(result.approvedBy.id, actor.id);
            } else {
              await assert.rejects(operation, error => error.getStatus() === 403);
              assert.equal(doc.status, DocumentStatus.PENDING);
            }
            checks++;
          }
          const request = { user: actor, params: { id: 'document-1' } };
          const guard = new DocumentAccessGuard({ findOne: async () => document(docDept) }, {});
          const operation = guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) });
          if (allowed) assert.equal(await operation, true);
          else await assert.rejects(operation, error => error.getStatus() === 403);
          checks++;
          const statusContext = {
            docsRepo: { findOne: async () => document(docDept) },
            viewRequestsRepo: { find: async () => [] },
          };
          const status = await ViewRequestsService.prototype.getViewStatus.call(statusContext, 'document-1', actor);
          assert.equal(status.canView === true, allowed, 'view-status must recognize upload reviewers');
          checks++;
        }

        let sql;
        const context = service(null);
        context.docsRepo.createQueryBuilder = alias => {
          const qb = ds.getRepository(Document).createQueryBuilder(alias);
          qb.getManyAndCount = async () => { sql = qb.getQueryAndParameters(); return [[], 0]; };
          return qb;
        };
        const operation = context.findPendingQueue(actor);
        if (reviewer) {
          await operation;
          assert.equal(sql[0].includes('`department`.`id` = ?'), role !== 'admin');
          if (role !== 'admin') assert(sql[1].includes(departmentId));
        } else await assert.rejects(operation, error => error.getStatus() === 403);
        checks++;
      }
    }
  }

  const users = Object.create(UsersService.prototype);
  const choices = users.getAssignablePermissions().map(item => item.key);
  assert(choices.includes('approve_documents'));
  assert(!choices.includes('download_documents'));
  assert(!choices.includes('request_document_view'));
  assert.deepEqual(users.withEffectivePermissions({ role: 'user', permissions: ['request_document_view'] }).permissions, ['view_department_documents']);
  for (const permission of ['view_department_documents', 'request_document_view']) {
    for (const docDept of ['dept-a', 'dept-b', undefined]) {
      for (const status of ['pending', 'stored', 'approved', 'rejected']) {
        for (const visibility of ['department', 'private', 'public']) {
          const doc = { ...document(docDept), status, visibility };
          const actor = { id: 'reader', role: 'user', departmentId: 'dept-a', permissions: [permission] };
          const allowed = docDept === 'dept-a' && ['department', 'public'].includes(visibility) && ['stored', 'approved'].includes(status);
          assert.equal(canViewDepartmentDocument(doc, actor), allowed);
          if (allowed) {
            const context = { docsRepo: { findOne: async () => doc } };
            // No request repository: direct viewing must not depend on a request.
            const result = await ViewRequestsService.prototype.getViewStatus.call(context, doc.id, actor);
            assert.equal(result.canView, true);
            const guard = new DocumentAccessGuard(context.docsRepo, {});
            assert.equal(await guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ user: actor, params: { id: doc.id } }) }) }), true);
          }
          checks++;
        }
      }
    }
  }
  assert.deepEqual(users.withEffectivePermissions({ role: 'user', permissions: ['download_documents', 'approve_documents'] }).permissions, ['approve_documents']);
  for (const permission of ['download_documents', 'approve_documents']) {
    const errors = await validate(Object.assign(new UpdateUserPermissionsDto(), { permissions: [permission] }));
    assert.equal(errors.length === 0, permission === 'approve_documents');
  }
  for (const permissions of [[], ['download_documents'], ['approve_documents']]) {
    await assert.rejects(service(null).getFileForDownload('any', { role: 'user', permissions }), error => error.getStatus() === 403);
  }
  console.log(`PASS: ${checks} review, department scope and pending-file access checks; permission catalogue, DTO and legacy download denial checks passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
