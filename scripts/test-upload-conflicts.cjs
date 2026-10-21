// Offline upload behavior: no database, archive, SMTP or real upload is touched.
require('reflect-metadata');
process.env.NODE_ENV = 'test';
process.env.ARCHIVE_ENCRYPTION_ENABLED = 'false';
process.env.UPLOAD_SCAN_ENABLED = 'false';
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { DocumentsService } = require('../dist/documents/documents.service');
const { PDFDocument } = require('pdf-lib');

async function main() {
  let failure = null, events = 0, saves = 0;
  const service = Object.assign(Object.create(DocumentsService.prototype), {
    docsRepo: {
      create: value => value,
      save: async doc => { saves++; if (failure) throw failure; return { ...doc, id: randomUUID() }; },
    },
    storePhysicalFile: async () => ({ id: 'stored-file', storageKey: 'test-only/archive.pdf', fileHash: 'a'.repeat(64) }),
    appendDayLog() {},
    log: async () => {},
    eventEmitter: { emit() { events++; } },
  });
  const file = { originalname: 'test.pdf', size: 123, path: path.join(os.tmpdir(), `lths-no-file-${randomUUID()}`) };
  const user = { id: 'uploader', role: 'department_head', departmentId: 'test-department' };
  const dto = { title: 'Upload test', departmentId: user.departmentId };
  failure = { driverError: { errno: 1644, code: 'ER_SIGNAL_EXCEPTION', sqlMessage: 'CONTENT_CLAIMED_FOR_DESTRUCTION' } };
  for (const visibility of ['department', 'public', 'private']) {
    await assert.rejects(() => service.upload(file, { ...dto, visibility }, user), error =>
      error.getStatus?.() === 409 && error.getResponse().code === 'CONTENT_CLAIMED_FOR_DESTRUCTION');
  }
  assert.equal(events, 0, 'Rejected uploads must not notify reviewers');
  const batch = await service.uploadMultiple([file], user.departmentId, user);
  assert.equal(batch.success.length, 0);
  assert.equal(batch.failed.length, 1);
  assert(batch.failed[0].error.includes('quy trình hủy hồ sơ'));
  failure = new Error('unrelated database failure');
  await assert.rejects(() => service.upload(file, dto, user), error => error === failure);
  failure = null;
  const pending = await service.upload(file, dto, user);
  assert.equal(pending.status, 'pending');
  assert.equal(events, 1);
  const stored = await service.upload(file, { ...dto, visibility: 'private' }, user);
  assert.equal(stored.status, 'stored');
  assert.equal(saves, 7);
  const regularUser = { id: 'regular', role: 'user', departmentId: user.departmentId, permissions: [] };
  const cannotSelfApprove = await service.upload(file, { ...dto, autoApprove: true }, regularUser);
  assert.equal(cannotSelfApprove.status, 'pending', 'Client autoApprove must not grant review privileges');
  await assert.rejects(() => service.upload(file, { ...dto, departmentId: 'another-department' }, regularUser), error => error.getStatus?.() === 403);
  // Exercise real duplicate-file handling using isolated temporary files.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-upload-presence-'));
  process.env.UPLOAD_ARCHIVE_DIR = tempRoot;
  const staging = path.join(tempRoot, 'staging.pdf'), archive = path.join(tempRoot, 'archive.pdf');
  try {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    fs.writeFileSync(staging, bytes);
    const existing = { id: 'existing', storageKey: archive };
    const physical = Object.assign(Object.create(DocumentsService.prototype), {
      filesRepo: { findOne: async () => existing },
    });
    await assert.rejects(() => physical.storePhysicalFile({ ...file, path: staging, size: bytes.length }), error =>
      error.getStatus?.() === 409 && error.getResponse().code === 'STORED_FILE_MISSING');
    assert(fs.existsSync(staging), 'The incoming file must not be discarded when the stored copy is missing');
    fs.writeFileSync(archive, 'bad');
    await assert.rejects(() => physical.storePhysicalFile({ ...file, path: staging, size: bytes.length }), error =>
      error.getResponse?.().code === 'STORED_FILE_SIZE_MISMATCH');
    assert(fs.existsSync(staging));
    fs.writeFileSync(archive, bytes);
    assert.equal(await physical.storePhysicalFile({ ...file, path: staging, size: bytes.length }), existing);
    assert.equal(fs.existsSync(staging), false);
    assert.deepEqual(fs.readFileSync(archive), bytes);
    const pendingDoc = { id: 'missing-doc', status: 'pending', file: { storageKey: staging },
      storagePath: staging, fileSizeBytes: bytes.length, sha256Checksum: 'a'.repeat(64) };
    physical.getOrFail = async () => pendingDoc;
    await assert.rejects(() => physical.approve(pendingDoc.id, { id: 'admin', role: 'admin' }), error =>
      error.getResponse?.().code === 'STORED_FILE_MISSING');
    assert.equal(pendingDoc.status, 'pending', 'Missing bytes cannot be marked stored');
  } finally {
    for (const filename of [staging, archive]) if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.rmdirSync(tempRoot);
  }
  console.log('PASS: pending/private/batch uploads report destruction conflicts; unrelated errors propagate and normal uploads still succeed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
