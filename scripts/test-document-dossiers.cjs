require('reflect-metadata');
const assert = require('node:assert/strict');
const { DocumentsService } = require('../dist/documents/documents.service');
const { ForbiddenException } = require('@nestjs/common');
const root = { id: 'root', status: 'stored', uploader: { id: 'owner' }, department: { id: 'dept' },
  documentType: { id: 'type' }, visibility: 'department', securityLevel: 'normal' };
const actor = { id: 'owner', role: 'user', departmentId: 'dept' };
function service(doc = root) {
  return Object.assign(Object.create(DocumentsService.prototype), {
    getOrFail: async () => doc, getDetail: async id => ({ id }),
    storePhysicalFile: async () => ({ storageKey: 'archive', fileHash: 'hash' }),
    docsRepo: { create: value => value }, saveUploadedDocument: async value => value,
    log: async () => {}, appendDayLog() {}, eventEmitter: { emit() {} },
  });
}
async function main() {
  const upload = (svc, user = actor) => svc.upload({ originalname: 'extra.pdf', size: 10 },
    { title: 'Extra', dossierRootId: 'root', visibility: 'public', documentTypeId: 'other' }, user);
  const extra = await upload(service());
  assert.equal(extra.dossierRootId, 'root');
  assert.equal(extra.visibility, 'department');
  assert.equal(extra.department.id, 'dept');
  assert.equal(extra.documentType.id, 'type');
  assert.equal(extra.status, 'pending');
  const childService = service();
  childService.getOrFail = async id => id === 'root' ? { ...root, id: 'child', dossierRootId: 'actual-root' } : { ...root, id: 'actual-root' };
  assert.equal((await upload(childService)).dossierRootId, 'actual-root');
  assert.equal((await upload(service(), { id: 'admin', role: 'admin' })).status, 'pending');
  assert.equal((await upload(service(), { id: 'head', role: 'department_head', departmentId: 'dept' })).dossierRootId, 'root');
  assert.equal((await upload(service({ ...root, visibility: 'private' }))).status, 'stored');
  await assert.rejects(upload(service(), { ...actor, id: 'other' }), e => e.getStatus() === 403);
  await assert.rejects(upload(service({ ...root, status: 'pending' })), e => e.getStatus() === 400);
  await assert.rejects(upload(service({ ...root, destructionRequestId: 'request' })), e => e.getStatus() === 409);
  const svc = service();
  svc.docsRepo.find = async () => [{ id: 'root' }, { id: 'hidden' }, { id: 'extra' }];
  svc.getDetail = async id => { if (id === 'hidden') throw new ForbiddenException(); return { id }; };
  const result = await svc.getDossier('root', actor);
  assert.deepEqual(result.data.map(d => d.id), ['root', 'extra']);
  assert.equal(result.total, 2);
  const secondPage = await svc.getDossier('root', actor, { page: 2, limit: 1 });
  assert.deepEqual(secondPage.data.map(d => d.id), ['extra']);
  svc.getDetail = async () => { throw new ForbiddenException(); };
  await assert.rejects(svc.getDossier('root', actor), e => e.getStatus() === 403);
  console.log('Document dossier checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
