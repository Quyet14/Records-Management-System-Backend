// Offline behavior tests. Never connects to a database, sends an OTP, or deletes a real file.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { DataSource, Table } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const { DestructionService } = require('../dist/destruction/destruction.service');
const { DestructionInfrastructure } = require('../dist/destruction/destruction.infrastructure');
const { DestructionWorker } = require('../dist/destruction/destruction.worker');
const { DestructionBearerGuard } = require('../dist/destruction/destruction.controller');
const rules = require('../dist/destruction/destruction.rules');
const lifecycle = require('../dist/common/document-lifecycle');
const { Document } = require('../dist/entities/document.entity');
const { User } = require('../dist/entities/user.entity');
const { AuditLog } = require('../dist/entities/audit-log.entity');
const E = require('../dist/entities/destruction.entity');
const { DestructionWorkflow1792368000000 } = require('../dist/migrations/1792368000000-DestructionWorkflow');
const { RetentionService } = require('../dist/retention/retention.service');
const { beginBarrier, endBarrier } = require('../dist/destruction/backup-barrier');
const { DocumentsService } = require('../dist/documents/documents.service');
const { DocumentAccessGuard } = require('../dist/common/guards/document-access.guard');
const NOW = new Date('2026-10-19T03:00:00.000Z');
const policy = { version: 'test-policy', targets: ['external', 'cloud', 'nas'].map(key => ({ key, label: key, purgeWithinDays: 7, notes: 'TEST ONLY' })) };
const health = Object.fromEntries(['ready', 'otp', 'worker', 'immutableEvidence', 'malwareScanner', 'contentInventory', 'backupExclusion', 'restoreTombstones'].map(key => [key, true]));
health.backupPolicy = policy;
const uuid = () => randomUUID();
const admin = (permissions = []) => ({ id: uuid(), role: 'admin', permissions });
const creator = admin(), reviewer = admin(), senior1 = admin(), senior2 = admin();
const head = { id: uuid(), role: 'department_head', departmentId: 'dept-a', permissions: [] };
const user = { id: uuid(), role: 'user', departmentId: 'dept-a', permissions: [] };
let checks = 0;
async function status(fn, code) { await assert.rejects(fn, e => e.getStatus?.() === code); checks++; }
function fixture(level = 'normal') {
  return Object.assign(new Document(), { id: uuid(), title: 'Hồ sơ thử', originalFilename: 'test.pdf', documentNumber: 'HS-TEST',
    status: 'stored', classificationValue: 'timed', securityLevel: level, version: 1, legalHold: false,
    fileSizeBytes: 123, sha256Checksum: 'a'.repeat(64), storagePath: '/test-only/archive.pdf',
    file: { id: uuid(), storageKey: '/test-only/archive.pdf' }, uploader: { id: creator.id },
    department: { id: 'dept-a' }, documentType: { id: 'type', isPermanent: false, retentionBasis: 'document_date', retentionYears: 5 },
    retentionUntil: new Date('2025-12-31T23:59:59Z'), destructionRequestId: null, destroyedAt: null, destructionStartedAt: null });
}
function memory() {
  let tables = new Map(), now = new Date(NOW), tail = Promise.resolve();
  const rows = E => { if (!tables.has(E.name)) tables.set(E.name, []); return tables.get(E.name); };
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => row[key] === value);
  const manager = {
    query: async sql => sql.startsWith('SELECT UTC_TIMESTAMP') ? [{ server_now: new Date(now) }] : [],
    create: (E, data) => Object.assign(new E(), data),
    findOne: async (E, options) => manager.findOneBy(E, options.where),
    findOneBy: async (E, where) => structuredClone(rows(E).find(row => matches(row, where)) || null),
    findOneOrFail: async (E, options) => manager.findOneByOrFail(E, options.where),
    findOneByOrFail: async (E, where) => { const value = await manager.findOneBy(E, where); if (!value) throw Error('missing'); return value; },
    findBy: async (E, where) => structuredClone(rows(E).filter(row => matches(row, where))),
    find: async (E, options) => manager.findBy(E, options?.where),
    countBy: async (E, where) => rows(E).filter(row => matches(row, where)).length,
    insert: async (E, value) => { rows(E).push(structuredClone(value)); },
    save: async (E, value) => {
      const primary = E === EJob ? 'requestId' : E.name === 'DestructionAttachmentContent' ? 'attachmentId' : 'id';
      value.id ||= E === EJob ? undefined : uuid();
      const i = rows(E).findIndex(row => row[primary] === value[primary]);
      if (i >= 0) rows(E)[i] = structuredClone(value); else rows(E).push(structuredClone(value));
      return value;
    },
    update: async (E, where, value) => {
      if (typeof where === 'string') where = { [E === EJob ? 'requestId' : 'id']: where };
      for (const row of rows(E)) if (matches(row, where)) Object.assign(row, structuredClone(value));
    },
    getRepository: E => ({ createQueryBuilder() {
      let params = {};
      const qb = new Proxy({}, { get(_t, name) {
        if (name === 'getMany') return async () => structuredClone(E.name === 'DestructionOtpChallenge'
          ? rows(E).filter(r => r.actorId === params.actor && r.createdAt > params.cutoff).sort((a, b) => b.createdAt - a.createdAt)
          : rows(E).filter(r => r.status !== 'purged'));
        if (name === 'getCount') return async () => rows(E).filter(r => r.requestId === params.id && r.status !== params.status).length;
        return (...args) => { if (args[1] && typeof args[1] === 'object') Object.assign(params, args[1]); return qb; };
      } }); return qb;
    } }),
  };
  const EJob = E.DestructionJob;
  const db = { manager, getRepository: manager.getRepository, transaction: (_isolation, operation) => {
    const result = tail.then(async () => { const snapshot = structuredClone(tables); try { return await operation(manager); }
      catch (e) { tables = snapshot; throw e; } }); tail = result.catch(() => {}); return result;
  } };
  return { db, rows, setNow: value => { now = new Date(value); } };
}

async function main() {
  const disabled = new DestructionInfrastructure(new ConfigService({ DESTRUCTION_ENABLED: 'false' }));
  assert.equal(await disabled.health(), null);
  const store = memory(), calls = [], codes = new Map();
  const infrastructure = new DestructionInfrastructure(new ConfigService({ DESTRUCTION_ENABLED: 'true',
    DESTRUCTION_GATEWAY_URL: 'http://127.0.0.1:9999', DESTRUCTION_GATEWAY_SECRET: 'test-only-secret-'.repeat(4) }));
  let gatewayDown = false, deleteFails = false;
  infrastructure.call = async (operation, payload) => {
    calls.push(operation);
    if (gatewayDown) throw Error('offline');
    if (operation === 'health') return structuredClone(health);
    if (operation === 'scan-pdf') return { clean: true, readable: true };
    if (operation === 'otp/deliver') { codes.set(payload.challengeId, payload.otp); return { delivered: true }; }
    if (operation === 'evidence/put') return { immutable: true, sha256: payload.sha256 };
    if (operation === 'content/inventory') return { id: 'manifest-' + payload.documentId, documentId: payload.documentId,
      primaryChecksum: payload.snapshot.checksum, contentVersion: payload.snapshot.version,
      complete: true, safe: true, exclusiveOwnership: true, objects: [{ key: payload.documentId, sha256: payload.snapshot.checksum }] };
    if (operation === 'backup/exclude') return { excluded: true, restoreProtected: true, evidenceId: uuid() };
    if (operation === 'content/destroy') {
      if (deleteFails) throw Error('partial deletion');
      return { operationId: payload.operationId, manifestId: payload.manifestId, verifiedAbsent: true,
        primaryChecksum: 'a'.repeat(64), evidenceId: uuid(), objects: [{ key: payload.documentId, sha256: 'a'.repeat(64), verifiedAbsent: true, evidenceId: uuid() }] };
    }
    if (operation === 'backup/purge') return { verifiedAbsent: true, evidenceId: uuid() };
    throw Error('Unexpected gateway operation: ' + operation);
  };
  for (const actor of [creator, reviewer, senior1, senior2, head, user]) store.rows(User).push({ ...actor, isActive: true,
    department: actor.departmentId ? { id: actor.departmentId } : null, fullName: actor.role });
  const service = new DestructionService(store.db, infrastructure);
  assert.equal((await service.capabilities(creator)).waitHours, 24);
  assert.equal(rules.WAIT_MS, 24 * 60 * 60 * 1000);
  const pdf = await PDFDocument.create(); pdf.addPage();
  const evidenceName = 'Quyết định hủy (đã ký).pdf';
  const validPdf = { originalname: Buffer.from(`C:\\fakepath\\${evidenceName}`, 'utf8').toString('latin1'), buffer: Buffer.from(await pdf.save()) };
  const files = { decisionFile: [validPdf] };
  const bodyFor = docs => ({ documentIds: JSON.stringify(docs.map(doc => doc.id)), reason: 'Hết hạn', decisionNumber: 'QD-TEST',
    decisionDate: '2026-10-19', signedDocumentConfirmed: 'true', backupPolicyVersion: policy.version });
  // Exercise the complete request/approval/worker flow while retention is still in the future.
  const doc = fixture(); doc.retentionUntil = new Date('2030-01-01T00:00:00Z'); store.rows(Document).push(doc);
  assert.equal(rules.eligible(doc, NOW), true);
  assert.equal(rules.eligible(fixture(), NOW), true, 'Expired documents remain eligible');
  for (const patch of [{ legalHold: true }, { retentionUntil: null }, { retentionUntil: new Date('invalid') },
    { classificationValue: 'permanent' }, { documentType: { ...doc.documentType, isPermanent: true } },
    { status: 'pending' }, { destructionRequestId: uuid() }]) assert.equal(rules.eligible({ ...doc, ...patch }, NOW), false);
  assert.equal(rules.digest({ b: 2, a: { y: 1, x: 0 } }), rules.digest({ a: { x: 0, y: 1 }, b: 2 }));
  assert.equal(rules.requiredApprovals([fixture('unknown')]), 2);
  await status(() => service.create(bodyFor([doc]), files, user, uuid()), 404);
  await status(() => service.create(bodyFor([doc]), files, { ...user, role: 'admin' }, uuid()), 404);
  // Server reloads identity instead of trusting the caller's claimed department.
  const foreign = fixture(); foreign.department.id = 'dept-b'; store.rows(Document).push(foreign);
  await status(() => service.create(bodyFor([foreign]), files, head, uuid()), 404);
  await status(() => service.create(bodyFor([doc]), {}, creator, uuid()), 422);
  assert.equal(store.rows(E.DestructionRequest).length, 0);
  // Missing retention metadata is a different problem from a future retention date.
  // Report the exact document and blocker without creating any request/evidence/claim.
  const incomplete = fixture(); incomplete.retentionUntil = null; store.rows(Document).push(incomplete);
  await assert.rejects(() => service.create(bodyFor([incomplete]), files, creator, uuid()), error => {
    const body = error.getResponse?.();
    return error.getStatus?.() === 422 && body.code === 'INELIGIBLE_DOCUMENT'
      && body.message.includes(incomplete.id) && body.message.includes('chưa có ngày hết hạn bảo quản hợp lệ');
  });
  assert.equal(store.rows(E.DestructionRequest).length, 0);
  assert.equal(store.rows(E.DestructionAttachmentContent).length, 0);
  assert.equal(store.rows(Document).find(d => d.id === incomplete.id).destructionRequestId, null);
  for (const [patch, reason] of [
    [{ classificationValue: 'unclassified' }, 'chưa xác định giá trị'],
    [{ documentType: null }, 'chưa có loại hồ sơ'],
    [{ legalHold: true }, 'khóa bảo toàn'],
    [{ destructionRequestId: uuid() }, 'đề nghị hủy khác'],
  ]) assert(rules.eligibilityReasons({ ...fixture(), ...patch }).some(value => value.includes(reason)));
  await status(() => infrastructure.validatePdf({ ...validPdf, buffer: Buffer.from('%PDF- fake') }), 422);
  await status(() => infrastructure.validatePdf({ ...validPdf, buffer: Buffer.alloc(rules.MAX_PDF_BYTES + 1) }), 413);
  const key = uuid(), body = bodyFor([doc]);
  const request = await service.create(body, files, creator, key);
  assert.equal(request.status, 'pending');
  const worker = new DestructionWorker(store.db, service, infrastructure);
  await worker.run(request.id);
  assert.equal(calls.includes('content/destroy'), false, 'An unapproved early request cannot delete content');
  assert.equal(store.rows(E.DestructionAttachmentContent).length, 1);
  assert.equal(store.rows(E.DestructionAttachment)[0].filename, evidenceName);
  const evidenceDetail = await service.detail(request.id, creator);
  assert.equal(evidenceDetail.attachments[0].filename, evidenceName);
  assert.equal(evidenceDetail.attachments[0].originalFilename, evidenceName);
  const attachmentId = store.rows(E.DestructionAttachment)[0].id;
  assert.deepEqual((await service.content(request.id, attachmentId, creator)).bytes, validPdf.buffer);
  const evidenceCalls = calls.filter(c => c === 'evidence/put').length;
  gatewayDown = true;
  assert.deepEqual(await service.create(body, files, creator, key), request);
  assert.equal(calls.filter(c => c === 'evidence/put').length, evidenceCalls);
  gatewayDown = false;
  await status(() => service.create({ ...body, reason: 'Changed' }, files, creator, key), 409);
  await status(() => service.create(body, files, creator, uuid()), 409);
  await status(() => service.challenge(request.id, { purpose: 'approve' }, '"1"', creator), 403);
  const challenge = await service.challenge(request.id, { purpose: 'approve' }, '"1"', reviewer);
  assert.equal('otp' in challenge, false);
  await status(() => service.challenge(request.id, { purpose: 'approve' }, '"1"', reviewer), 429);
  const wrong = codes.get(challenge.challengeId) === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await status(() => service.approve(request.id, { challengeId: challenge.challengeId,
    otp: wrong, documentsReviewed: true }, '"1"', 'wrong-otp', reviewer), 422);
  assert.equal(store.rows(E.DestructionOtpChallenge)[0].attemptCount, 5);
  assert.equal(store.rows(E.DestructionIdempotency).some(r => r.result.otpFailure), false);
  await status(() => service.approve(request.id, { challengeId: challenge.challengeId,
    otp: codes.get(challenge.challengeId), documentsReviewed: true }, '"1"', uuid(), reviewer), 422);
  store.setNow(new Date(NOW.getTime() + 61000));
  const secondChallenge = await service.challenge(request.id, { purpose: 'approve' }, '"1"', reviewer);
  const approvalBody = { challengeId: secondChallenge.challengeId, otp: codes.get(secondChallenge.challengeId), documentsReviewed: true };
  const approvalKey = uuid();
  const scheduled = await service.approve(request.id, approvalBody, '"1"', approvalKey, reviewer);
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(new Date(scheduled.executeAfter).getTime(), NOW.getTime() + 61000 + rules.WAIT_MS);
  gatewayDown = true;
  assert.deepEqual(await service.approve(request.id, approvalBody, '"1"', approvalKey, reviewer), scheduled);
  gatewayDown = false;
  assert.equal(store.rows(E.DestructionApproval).length, 1);
  assert.equal(store.rows(E.DestructionJob).length, 1);
  await status(() => service.transition(request.id, 'withdraw', { reason: 'test' }, '"1"', uuid(), creator), 412);
  store.setNow(new Date(new Date(scheduled.executeAfter).getTime() - 1));
  await worker.run(request.id);
  assert.equal(calls.includes('content/destroy'), false, 'Even 1 ms before the 24-hour deadline must not delete');
  assert.equal(store.rows(Document).find(d => d.id === doc.id).status, 'stored');
  store.setNow(scheduled.executeAfter);
  await status(() => service.transition(request.id, 'withdraw', { reason: 'test' }, '"2"', uuid(), creator), 409);
  assert(new Date(scheduled.executeAfter) < doc.retentionUntil, 'Destruction is tested before retention expires');
  await worker.run(request.id);
  assert.equal(store.rows(Document).find(d => d.id === doc.id).status, 'destroyed');
  assert.equal(store.rows(E.DestructionRequest)[0].status, 'destroyed');
  assert.equal(store.rows(E.DestructionBackupDisposition).length, 3);
  assert(calls.indexOf('backup/exclude') < calls.indexOf('content/destroy'));
  const deletionCount = calls.filter(c => c === 'content/destroy').length;
  await worker.run(request.id);
  assert.equal(calls.filter(c => c === 'content/destroy').length, deletionCount);
  assert.throws(() => lifecycle.assertDocumentContentAvailable({ ...doc, status: 'destroyed' }), e => e.getStatus() === 410);
  assert.throws(() => lifecycle.assertDocumentContentAvailable({ ...doc, destructionStartedAt: NOW }), e => e.getStatus() === 410);
  assert.throws(() => lifecycle.assertDocumentMutable({ ...doc, destructionRequestId: request.id }), e => e.getStatus() === 409);
  const finishedVersion = store.rows(E.DestructionRequest)[0].version;
  await status(() => service.complete(request.id, { signedDocumentConfirmed: 'true', backupDispositionNotes: 'Từng đích đang chờ purge' }, {}, `"${finishedVersion}"`, uuid(), creator), 422);
  const completed = await service.complete(request.id, { signedDocumentConfirmed: 'true', backupDispositionNotes: 'Ba đích đang chờ purge' },
    { destructionMinutesFile: [validPdf] }, `"${finishedVersion}"`, uuid(), creator);
  assert.equal(completed.status, 'completed');
  await worker.reconcileBackups();
  assert(store.rows(E.DestructionBackupDisposition).every(d => d.status === 'purged'));
  // A failed deletion never marks a document destroyed and keeps the persisted manifest for operations retry.
  const failureDoc = fixture(); store.rows(Document).push(failureDoc);
  const failing = await service.create(bodyFor([failureDoc]), files, creator, uuid());
  const c = await service.challenge(failing.id, { purpose: 'approve' }, '"1"', senior1);
  const fscheduled = await service.approve(failing.id, { challengeId: c.challengeId, otp: codes.get(c.challengeId), documentsReviewed: true }, '"1"', uuid(), senior1);
  store.setNow(fscheduled.executeAfter); deleteFails = true;
  worker.logger = { error() {} };
  await worker.run(failing.id);
  assert.equal(store.rows(E.DestructionRequest).find(r => r.id === failing.id).status, 'failed');
  assert.equal(store.rows(Document).find(d => d.id === failureDoc.id).status, 'stored');
  assert.equal(store.rows(E.DestructionItem).find(i => i.requestId === failing.id).status, 'deleting');
  assert(store.rows(E.DestructionItem).find(i => i.requestId === failing.id).executionResult.manifest);
  deleteFails = false;
  // Operations explicitly requeues after inspection; existing manifest/operation ID remain unchanged.
  store.rows(E.DestructionRequest).find(r => r.id === failing.id).status = 'scheduled';
  store.rows(E.DestructionJob).find(j => j.requestId === failing.id).status = 'scheduled';
  await worker.run(failing.id);
  assert.equal(store.rows(Document).find(d => d.id === failureDoc.id).status, 'destroyed');
  // Sensitive requests need one Admin and the document's department head, in either order.
  const secret = fixture('secret'); store.rows(Document).push(secret);
  const sensitive = await service.create(bodyFor([secret]), files, creator, uuid());
  assert.equal(rules.canApprove(store.rows(E.DestructionRequest).find(r => r.id === sensitive.id), reviewer, []), true);
  const sc1 = await service.challenge(sensitive.id, { purpose: 'approve' }, '"1"', senior1);
  const partial = await service.approve(sensitive.id, { challengeId: sc1.challengeId, otp: codes.get(sc1.challengeId), documentsReviewed: true }, '"1"', uuid(), senior1);
  assert.equal(partial.status, 'partially_approved'); assert.equal(partial.executeAfter, null);
  assert.equal(store.rows(E.DestructionJob).some(j => j.requestId === sensitive.id), false);
  await status(() => service.challenge(sensitive.id, { purpose: 'approve' }, '"2"', senior1), 403);
  await status(() => service.challenge(sensitive.id, { purpose: 'approve' }, '"2"', senior2), 403);
  const sc2 = await service.challenge(sensitive.id, { purpose: 'approve' }, '"2"', head);
  await status(() => service.approve(sensitive.id, { challengeId: sc1.challengeId, otp: codes.get(sc1.challengeId), documentsReviewed: true }, '"2"', uuid(), head), 422);
  const final = await service.approve(sensitive.id, { challengeId: sc2.challengeId, otp: codes.get(sc2.challengeId), documentsReviewed: true }, '"2"', uuid(), head);
  assert.equal(final.status, 'scheduled');
  const withdrawn = await service.transition(sensitive.id, 'withdraw', { reason: 'Cần chỉnh sửa' }, '"3"', uuid(), creator);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(store.rows(Document).find(d => d.id === secret.id).destructionRequestId, null);
  assert(store.rows(E.DestructionAttachment).some(a => a.requestId === sensitive.id));
  const resubmitted = await service.create(bodyFor([secret]), files, creator, uuid());
  assert.equal(resubmitted.status, 'pending');
  // A legal hold raised while waiting is rechecked at the worker boundary; no deletion is attempted.
  const held = fixture(); store.rows(Document).push(held);
  const heldRequest = await service.create(bodyFor([held]), files, creator, uuid());
  store.setNow(new Date(new Date(fscheduled.executeAfter).getTime() + 61000));
  const hc = await service.challenge(heldRequest.id, { purpose: 'approve' }, '"1"', reviewer);
  const hs = await service.approve(heldRequest.id, { challengeId: hc.challengeId, otp: codes.get(hc.challengeId), documentsReviewed: true }, '"1"', uuid(), reviewer);
  store.rows(Document).find(d => d.id === held.id).legalHold = true;
  store.setNow(hs.executeAfter);
  const beforeHold = calls.filter(c => c === 'content/destroy').length;
  await worker.run(heldRequest.id);
  assert.equal(calls.filter(c => c === 'content/destroy').length, beforeHold);
  assert.equal(store.rows(E.DestructionRequest).find(r => r.id === heldRequest.id).status, 'failed');
  // PDF scan failure leaves neither an evidence blob nor an available partial request.
  const other = fixture(); store.rows(Document).push(other);
  const originalCall = infrastructure.call;
  const countBefore = store.rows(E.DestructionRequest).length, blobsBefore = store.rows(E.DestructionAttachmentContent).length;
  infrastructure.call = async (operation, payload) => operation === 'scan-pdf' ? { clean: false, readable: true } : originalCall(operation, payload);
  await status(() => service.create(bodyFor([other]), files, creator, uuid()), 422);
  assert.equal(store.rows(E.DestructionRequest).length, countBefore);
  assert.equal(store.rows(E.DestructionAttachmentContent).length, blobsBefore);
  infrastructure.call = originalCall;
  // An explicit disk-only policy preserves unused statuses without manufacturing purge receipts.
  health.backupPolicy = { ...policy, targets: policy.targets.map(t => t.key === 'external' ? t : {
    ...t, enabled: false, purgeWithinDays: 0, notes: 'No copies on this destination (test fixture)',
  }) };
  const diskDoc = fixture(); store.rows(Document).push(diskDoc);
  const diskRequest = await service.create(bodyFor([diskDoc]), files, creator, uuid());
  const diskChallenge = await service.challenge(diskRequest.id, { purpose: 'approve' }, '"1"', reviewer);
  const diskScheduled = await service.approve(diskRequest.id, { challengeId: diskChallenge.challengeId,
    otp: codes.get(diskChallenge.challengeId), documentsReviewed: true }, '"1"', uuid(), reviewer);
  store.setNow(diskScheduled.executeAfter);
  const exclusionsBefore = calls.filter(c => c === 'backup/exclude').length;
  await worker.run(diskRequest.id);
  assert.equal(store.rows(Document).find(d => d.id === diskDoc.id).status, 'destroyed');
  assert.equal(calls.filter(c => c === 'backup/exclude').length - exclusionsBefore, 1);
  assert.equal(store.rows(E.DestructionBackupDisposition).filter(d => d.requestId === diskRequest.id).length, 1);
  const diskDetail = await service.detail(diskRequest.id, creator);
  assert.equal(diskDetail.backupDispositions.filter(d => d.status === 'not_used' && d.purgedAt === null && d.purgeDueAt === null).length, 2);
  health.backupPolicy = policy;
  // Existing endpoints must block destroyed content even for owner/admin and an old file token.
  const gone = { ...doc, status: 'destroyed' };
  const docsService = Object.assign(Object.create(DocumentsService.prototype), { getOrFail: async () => gone });
  await status(() => docsService.getFileForDownload(doc.id, { ...creator, fileId: doc.id }), 410);
  await status(() => docsService.getFileForView(doc, creator), 410);
  const guard = new DocumentAccessGuard({ findOne: async () => gone }, {});
  await status(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ user: creator, params: { id: doc.id } }) }) }), 410);
  const bearer = new DestructionBearerGuard();
  assert.throws(() => bearer.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: {}, user: creator }) }) }), e => e.getStatus() === 401);
  assert.throws(() => bearer.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer token' }, user: { tokenType: 'file-download' } }) }) }), e => e.getStatus() === 401);
  // Legacy upload-date retention cannot silently become destruction eligibility.
  const retention = Object.assign(Object.create(RetentionService.prototype), { docRepo: { save: async d => d } });
  const legacy = { ...fixture(), documentDate: null, createdAt: new Date('2000-01-01'), approvedAt: NOW };
  await retention.computeAndSaveExpiry(legacy); assert.equal(legacy.retentionUntil, null);
  const dated = { ...fixture(), documentDate: new Date('2000-01-01'), approvedAt: NOW };
  await retention.computeAndSaveExpiry(dated); assert.equal(dated.retentionUntil.toISOString(), '2005-01-01T23:59:59.999Z');
  // New backups require a tombstone-filtered stable snapshot after the first destruction request.
  const savedEnv = { url: process.env.DESTRUCTION_GATEWAY_URL, enabled: process.env.DESTRUCTION_ENABLED,
    root: process.env.DESTRUCTION_BACKUP_STAGING_ROOT };
  const os = require('node:os');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-destruction-test-'));
  const snapshotDir = path.join(tempRoot, 'snapshot'); fs.mkdirSync(snapshotDir);
  try {
    delete process.env.DESTRUCTION_GATEWAY_URL; delete process.env.DESTRUCTION_ENABLED;
    const legacyBarrier = await beginBarrier({ query: async () => [] }, disabled, 'legacy-archive');
    assert.equal(legacyBarrier.sessionId, null);
    await status(() => beginBarrier({ query: async () => [{ present: 1 }] }, disabled, 'archive'), 503);
    process.env.DESTRUCTION_BACKUP_STAGING_ROOT = tempRoot;
    const barrierCalls = [];
    const safeGateway = { call: async (operation, payload) => {
      barrierCalls.push([operation, payload]);
      if (operation === 'backup/begin') return { sessionId: 'backup-session', maintenanceProtected: true,
        exclusionsApplied: true, snapshotStable: true, sourceDirectory: snapshotDir };
      if (operation === 'restore/begin') return { sessionId: 'restore-session', maintenanceProtected: true };
      if (operation === 'restore/apply-tombstones') return { applied: true, verified: true, evidenceId: 'receipt' };
      return { closed: true };
    } };
    const b = await beginBarrier({ query: async () => [{ present: 1 }] }, safeGateway, 'archive');
    assert.equal(b.sourceDirectory, fs.realpathSync(snapshotDir));
    await endBarrier(safeGateway, b, true);
    const r = await beginBarrier({ query: async () => [{ present: 1 }] }, safeGateway, 'archive', 'restore');
    const callCount = barrierCalls.length;
    await endBarrier(safeGateway, r, false);
    assert.equal(barrierCalls.length, callCount, 'Failed restore must stay in maintenance');
    await endBarrier(safeGateway, r, true);
    assert.deepEqual(barrierCalls.slice(-2).map(c => c[0]), ['restore/apply-tombstones', 'restore/end']);
    const unsafeGateway = { call: async () => ({ sessionId: 'bad', maintenanceProtected: true,
      exclusionsApplied: true, snapshotStable: true, sourceDirectory: tempRoot }) };
    await status(() => beginBarrier({ query: async () => [{ present: 1 }] }, unsafeGateway, 'archive'), 503);
  } finally {
    for (const [key, value] of [['DESTRUCTION_GATEWAY_URL', savedEnv.url], ['DESTRUCTION_ENABLED', savedEnv.enabled], ['DESTRUCTION_BACKUP_STAGING_ROOT', savedEnv.root]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmdirSync(snapshotDir); fs.rmdirSync(tempRoot);
  }
  // Compile real MySQL table/constraint metadata and inspect migration guards without running DDL.
  const entities = fs.readdirSync(path.join(__dirname, '../dist/entities')).filter(n => n.endsWith('.entity.js'))
    .flatMap(n => Object.values(require('../dist/entities/' + n)).filter(v => typeof v === 'function'));
  const ds = new DataSource({ type: 'mysql', database: 'offline', entities }); await ds.buildMetadatas();
  const sql = [], fks = [];
  const migration = new DestructionWorkflow1792368000000();
  const q = { connection: ds, getTable: async name => name === 'documents' ? { findColumnByName: column => column === 'status'
    ? { name: 'status', type: 'enum', enum: ['pending', 'stored', 'custom_existing_status'] } : { isNullable: true }, foreignKeys: [] }
    : { foreignKeys: [], findColumnByName: () => ({ isNullable: true }) },
    hasColumn: async () => false, addColumn: async () => {}, changeColumn: async (_table, _old, next) => {
      assert(next.enum.includes('custom_existing_status')); assert(next.enum.includes('destroyed'));
    }, createTable: async table => { assert(table.columns.length > 0); }, createForeignKey: async (_table, fk) => { fks.push(fk); },
    query: async query => { sql.push(query); return query.startsWith('SHOW FULL') ? [{ Type: 'varchar(36)', Collation: 'utf8mb4_unicode_ci' }] : []; } };
  await migration.up(q);
  const createdTriggers = sql.filter(s => s.startsWith('CREATE TRIGGER')).map(s => s.match(/CREATE TRIGGER `([^`]+)`/)[1]);
  assert.deepEqual(createdTriggers.sort(), [...require('../dist/migrations/1792368000000-DestructionWorkflow').DESTRUCTION_REQUIRED_TRIGGERS].sort());
  assert.equal(fks.length, 16); assert(fks.every(fk => fk.onDelete === 'RESTRICT'));
  assert(sql.some(s => s.includes('DESTRUCTION_STARTED_LEGAL_HOLD_LOCKED')));
  assert(sql.some(s => s.includes('DESTRUCTION_RECORD_APPEND_ONLY')));
  for (const entity of E.destructionEntities) assert(Table.create(ds.getMetadata(entity), ds.driver).columns.length > 0);
  assert.equal(store.rows(AuditLog).every(log => !JSON.stringify(log).includes('verifierHash')), true);
  // A department head can review only a request whose every document is in scope.
  const ownDoc = fixture('confidential'), otherDoc = fixture(); otherDoc.department.id = 'dept-b';
  const draft = { createdBy: creator.id, status: 'pending', requiredApprovals: 2 };
  assert.equal(rules.canApprove(draft, head, [], [ownDoc]), true);
  assert.equal(rules.canApprove(draft, head, [], [ownDoc, otherDoc]), false);
  assert.equal(rules.canApprove(draft, { ...head, departmentId: undefined }, [], [ownDoc]), false);
  assert.equal(rules.canApprove(draft, user, [], [ownDoc]), false);
  assert.equal(rules.canApprove({ ...draft, createdBy: head.id }, head, [], [ownDoc]), false);
  assert.equal(rules.canApprove(draft, head, [{ userId: head.id }], [ownDoc]), false);
  assert.equal(rules.canApprove(draft, head, [], []), false);
  assert.equal(rules.canApprove(draft, head, [], [fixture('top_secret')]), true);
  assert(rules.actions(draft, head, [], NOW, [ownDoc]).includes('approve'));
  // Exercise actual OTP, approval and worker with a head, including a changed department.
  store.setNow(new Date('2027-01-01T00:00:00Z'));
  store.rows(Document).push(ownDoc, otherDoc);
  const departmentRequest = await service.create(bodyFor([ownDoc]), files, creator, uuid());
  await status(() => service.challenge(departmentRequest.id, { purpose: 'approve' }, '"1"', { ...head, id: user.id }), 404);
  const otherRequest = await service.create(bodyFor([otherDoc]), files, creator, uuid());
  await status(() => service.challenge(otherRequest.id, { purpose: 'approve' }, '"1"', head), 404);
  const mixedOwn = fixture(), mixedOther = fixture(); mixedOther.department.id = 'dept-b';
  store.rows(Document).push(mixedOwn, mixedOther);
  const mixedRequest = await service.create(bodyFor([mixedOwn, mixedOther]), files, creator, uuid());
  await status(() => service.challenge(mixedRequest.id, { purpose: 'approve' }, '"1"', head), 404);
  const headChallenge = await service.challenge(departmentRequest.id, { purpose: 'approve' }, '"1"', head);
  const headApproval = await service.approve(departmentRequest.id, { challengeId: headChallenge.challengeId,
    otp: codes.get(headChallenge.challengeId), documentsReviewed: true }, '"1"', uuid(), head);
  assert.equal(headApproval.status, 'partially_approved');
  const adminChallenge = await service.challenge(departmentRequest.id, { purpose: 'approve' }, '"2"', reviewer);
  const departmentScheduled = await service.approve(departmentRequest.id, { challengeId: adminChallenge.challengeId,
    otp: codes.get(adminChallenge.challengeId), documentsReviewed: true }, '"2"', uuid(), reviewer);
  assert.equal(departmentScheduled.status, 'scheduled');
  store.setNow(departmentScheduled.executeAfter);
  const headRow = store.rows(User).find(u => u.id === head.id);
  headRow.department.id = 'dept-b';
  const beforeDepartmentChange = calls.filter(c => c === 'content/destroy').length;
  await worker.run(departmentRequest.id);
  assert.equal(calls.filter(c => c === 'content/destroy').length, beforeDepartmentChange);
  assert.equal(store.rows(E.DestructionRequest).find(r => r.id === departmentRequest.id).status, 'failed');
  // Operations requeues only after reviewing and restoring the approver's department.
  store.rows(User).find(u => u.id === head.id).department.id = 'dept-a';
  store.rows(E.DestructionRequest).find(r => r.id === departmentRequest.id).status = 'scheduled';
  store.rows(E.DestructionJob).find(j => j.requestId === departmentRequest.id).status = 'scheduled';
  await worker.run(departmentRequest.id);
  assert.equal(store.rows(Document).find(d => d.id === ownDoc.id).status, 'destroyed');
  // Role composition is mandatory even for already scheduled or legacy approvals.
  const sensitiveDraft = { ...draft, digest: 'role-pair-test' }, sensitiveDoc = fixture('top_secret');
  const votesFor = actors => actors.map(actor => ({ userId: actor.id, digest: sensitiveDraft.digest }));
  const head2 = { ...head, id: uuid() };
  assert.equal(rules.approvalsValid(sensitiveDraft, [sensitiveDoc], votesFor([reviewer, senior1]), [reviewer, senior1]), false);
  assert.equal(rules.approvalsValid(sensitiveDraft, [sensitiveDoc], votesFor([head, head2]), [head, head2]), false);
  assert.equal(rules.approvalsValid(sensitiveDraft, [sensitiveDoc], votesFor([reviewer, head]), [reviewer, head]), true);
  assert.equal(rules.canApprove(draft, reviewer, votesFor([senior1]), [sensitiveDoc], [senior1]), false);
  assert.equal(rules.canApprove(draft, head2, votesFor([head]), [sensitiveDoc], [head]), false);
  const noDepartment = fixture('confidential'); noDepartment.department = null; store.rows(Document).push(noDepartment);
  await status(() => service.create(bodyFor([noDepartment]), files, creator, uuid()), 422);
  const mixedSensitive = fixture('confidential'), mixedForeign = fixture(); mixedForeign.department.id = 'dept-b';
  store.rows(Document).push(mixedSensitive, mixedForeign);
  await status(() => service.create(bodyFor([mixedSensitive, mixedForeign]), files, creator, uuid()), 422);
  // One-step head approval works for ordinary records, including their own uploaded request.
  const selfDoc = fixture(); selfDoc.uploader.id = head.id; store.rows(Document).push(selfDoc);
  const selfRequest = await service.create(bodyFor([selfDoc]), files, head, uuid());
  assert.equal(selfRequest.status, 'pending');
  const selfDraft = { ...draft, requiredApprovals: 1, createdBy: head.id };
  assert.equal(rules.canApprove(selfDraft, head, [], [selfDoc]), true);
  assert.equal(rules.canApprove(selfDraft, head, [], [fixture()]), false);
  assert.equal(rules.canApprove(selfDraft, head, [], [selfDoc, fixture()]), false);
  assert.equal(rules.canApprove({ ...selfDraft, createdBy: reviewer.id }, reviewer, [], [selfDoc]), false);
  store.setNow(new Date(new Date(departmentScheduled.executeAfter).getTime() + 61000));
  const selfChallenge = await service.challenge(selfRequest.id, { purpose: 'approve' }, '"1"', head);
  const selfScheduled = await service.approve(selfRequest.id, { challengeId: selfChallenge.challengeId,
    otp: codes.get(selfChallenge.challengeId), documentsReviewed: true }, '"1"', uuid(), head);
  assert.equal(selfScheduled.status, 'scheduled');
  await worker.run(selfRequest.id);
  assert.equal(store.rows(Document).find(d => d.id === selfDoc.id).status, 'stored');
  store.setNow(selfScheduled.executeAfter);
  await worker.run(selfRequest.id);
  assert.equal(store.rows(Document).find(d => d.id === selfDoc.id).status, 'destroyed');
  // Existing 48-hour jobs can be explicitly shortened without deleting approval/evidence records.
  const { reschedule } = require('./reschedule-destruction.cjs');
  const legacyDoc = fixture(); store.rows(Document).push(legacyDoc);
  const legacyRequest = await service.create(bodyFor([legacyDoc]), files, creator, uuid());
  const legacyChallenge = await service.challenge(legacyRequest.id, { purpose: 'approve' }, '"1"', reviewer);
  const legacyScheduled = await service.approve(legacyRequest.id, { challengeId: legacyChallenge.challengeId,
    otp: codes.get(legacyChallenge.challengeId), documentsReviewed: true }, '"1"', uuid(), reviewer);
  const legacyRow = store.rows(E.DestructionRequest).find(r => r.id === legacyRequest.id);
  const legacyJob = store.rows(E.DestructionJob).find(j => j.requestId === legacyRequest.id);
  legacyRow.executeAfter = new Date(new Date(legacyScheduled.executeAfter).getTime() + 86400000);
  legacyJob.runAt = legacyRow.executeAfter;
  const previousTime = legacyRow.executeAfter.toISOString(), auditCount = store.rows(AuditLog).length;
  const preview = await reschedule(store.db.manager, legacyRequest.id);
  assert.equal(preview.applied, false);
  assert.equal(legacyRow.executeAfter.toISOString(), previousTime);
  assert.equal(store.rows(AuditLog).length, auditCount);
  const applied = await store.db.transaction('READ COMMITTED', m => reschedule(m, legacyRequest.id, true));
  assert.equal(applied.executeAfter, new Date(legacyScheduled.executeAfter).toISOString());
  const updatedJob = store.rows(E.DestructionJob).find(j => j.requestId === legacyRequest.id);
  assert.equal(updatedJob.runAt.toISOString(), applied.executeAfter);
  assert.equal(store.rows(E.DestructionRequest).find(r => r.id === legacyRequest.id).version, 3);
  assert.equal(store.rows(AuditLog).length, auditCount + 1);
  assert.equal((await reschedule(store.db.manager, legacyRequest.id, true)).applied, false);
  assert.equal(store.rows(E.DestructionRequest).find(r => r.id === legacyRequest.id).version, 3);
  updatedJob.leaseOwner = 'active-worker';
  await assert.rejects(() => reschedule(store.db.manager, legacyRequest.id, true), /unstarted scheduled/);
  updatedJob.leaseOwner = null;
  store.setNow(new Date(new Date(applied.executeAfter).getTime() - 1));
  await worker.run(legacyRequest.id);
  assert.equal(store.rows(Document).find(d => d.id === legacyDoc.id).status, 'stored');
  store.setNow(applied.executeAfter);
  await worker.run(legacyRequest.id);
  assert.equal(store.rows(Document).find(d => d.id === legacyDoc.id).status, 'destroyed');
  // Users submit only their own uploads in their current department, without review powers.
  assert.equal((await service.capabilities(user)).canCreate, true);
  assert.equal((await service.capabilities({ ...user, departmentId: undefined })).canCreate, false);
  const userDoc = fixture('secret'); userDoc.uploader.id = user.id; store.rows(Document).push(userDoc);
  const otherDepartmentDoc = fixture(); otherDepartmentDoc.uploader.id = user.id;
  otherDepartmentDoc.department.id = 'dept-b'; store.rows(Document).push(otherDepartmentDoc);
  assert.equal(rules.documentScope(userDoc, user), true);
  assert.equal(rules.documentScope(otherDepartmentDoc, user), false);
  assert.equal(rules.documentScope(fixture(), user), false);
  await status(() => service.create(bodyFor([otherDepartmentDoc]), files, user, uuid()), 404);
  await status(() => service.create(bodyFor([userDoc, otherDepartmentDoc]), files, user, uuid()), 404);
  assert.equal(store.rows(Document).find(d => d.id === userDoc.id).destructionRequestId, null);
  const userKey = uuid(), userBody = bodyFor([userDoc]);
  const userRequest = await service.create(userBody, files, user, userKey);
  assert.equal(userRequest.status, 'pending');
  assert.deepEqual(await service.create(userBody, files, user, userKey), userRequest);
  const userDetail = await service.detail(userRequest.id, user);
  assert.deepEqual(userDetail.allowedActions, ['withdraw']);
  assert.deepEqual((await service.content(userRequest.id, userDetail.attachments[0].id, user)).bytes, validPdf.buffer);
  await status(() => service.request(store.db.manager, request.id, user), 404);
  const peer = { ...user, id: uuid() };
  await status(() => service.detail(userRequest.id, peer), 404);
  await status(() => service.content(userRequest.id, userDetail.attachments[0].id, peer), 404);
  const votesBefore = store.rows(E.DestructionApproval).length;
  const jobsBefore = store.rows(E.DestructionJob).length;
  await status(() => service.challenge(userRequest.id, { purpose: 'approve' }, '"1"', user), 403);
  await status(() => service.approve(userRequest.id, { challengeId: uuid(), otp: '123456', documentsReviewed: true }, '"1"', uuid(), user), 403);
  await status(() => service.transition(userRequest.id, 'reject', { reason: 'Không được duyệt' }, '"1"', uuid(), user), 409);
  assert.equal(store.rows(E.DestructionApproval).length, votesBefore);
  assert.equal(store.rows(E.DestructionJob).length, jobsBefore);
  assert((await service.detail(userRequest.id, head)).allowedActions.includes('approve'));
  assert((await service.detail(userRequest.id, reviewer)).allowedActions.includes('approve'));
  // A department change also revokes visibility and idempotent replay of the old request.
  const userRow = store.rows(User).find(u => u.id === user.id);
  userRow.department = { id: 'dept-b' };
  await status(() => service.create(userBody, files, user, userKey), 404);
  await status(() => service.detail(userRequest.id, { ...user, departmentId: 'dept-b' }), 404);
  store.rows(User).find(u => u.id === user.id).department = { id: 'dept-a' };
  const userWithdrawn = await service.transition(userRequest.id, 'withdraw', { reason: 'Thu hồi yêu cầu' }, '"1"', uuid(), user);
  assert.equal(userWithdrawn.status, 'withdrawn');
  assert.equal(store.rows(Document).find(d => d.id === userDoc.id).destructionRequestId, null);
  store.rows(User).find(u => u.id === user.id).department = null;
  await status(() => service.create(bodyFor([userDoc]), files, user, uuid()), 403);
  store.rows(User).find(u => u.id === user.id).department = { id: 'dept-a' };
  console.log(`PASS: destruction workflow, user ownership/department restrictions, OTP attempt persistence/replay, policy, two-person approval, withdrawal, worker checkpoints, backups, content guards, retention and migration metadata (${checks} rejection cases).`);
  console.log('LIMIT: offline transaction simulation; live MySQL row-lock races, DDL and SAN/gateway acceptance remain staging checks.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
