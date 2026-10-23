require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { encryptArchiveFile, rawChecksum } = require('../dist/common/archive-crypto');
const { writeReadableDocument, removeReadableDocument, readableRoot } = require('../dist/common/readable-copy');
const { DocumentsService } = require('../dist/documents/documents.service');
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { digest } = require('../dist/destruction/destruction.rules');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-readable-'));
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = 'test';
    process.env.ARCHIVE_ENCRYPTION_ENABLED = 'true';
    process.env.ARCHIVE_ALLOW_LEGACY_READ = 'false';
    process.env.UPLOAD_ARCHIVE_DIR = path.join(root, 'archive');
    process.env.DOCUMENT_READABLE_DIR = path.join(root, 'readable');
    process.env.ARCHIVE_KEY_FILE = path.join(root, 'keys.json');
    fs.mkdirSync(process.env.UPLOAD_ARCHIVE_DIR);
    fs.writeFileSync(process.env.ARCHIVE_KEY_FILE, JSON.stringify({ current: 'test', keys: { test: crypto.randomBytes(32).toString('base64') } }), { mode: 0o600 });
    const bytes = crypto.randomBytes(1024 * 1024 + 17);
    const source = path.join(root, 'source');
    fs.writeFileSync(source, bytes);
    const hash = await rawChecksum(source);
    const archive = path.join(process.env.UPLOAD_ARCHIVE_DIR, 'test.lths');
    await encryptArchiveFile(source, archive, hash);
    const makeDoc = () => ({ id: crypto.randomUUID(), originalFilename: 'Tài liệu.pdf', storagePath: archive,
      sha256Checksum: hash, fileSizeBytes: bytes.length, file: { storageKey: archive, fileHash: hash } });
    const filename = doc => path.join(process.env.DOCUMENT_READABLE_DIR, doc.id, doc.originalFilename);
    const first = makeDoc();
    assert.equal(await writeReadableDocument(first), true);
    assert.deepEqual(fs.readFileSync(filename(first)), bytes);
    assert.equal(await writeReadableDocument(first), false);
    const second = makeDoc();
    await writeReadableDocument(second);
    assert.deepEqual(fs.readFileSync(filename(second)), bytes);
    fs.writeFileSync(filename(first), 'changed');
    await assert.rejects(() => writeReadableDocument(first), /changed/);
    assert.equal(fs.readFileSync(filename(first), 'utf8'), 'changed');
    await removeReadableDocument(first.id);
    assert(!fs.existsSync(path.dirname(filename(first))));
    assert(fs.existsSync(filename(second)));
    await removeReadableDocument(first.id);

    const corrupt = makeDoc(), sealed = fs.readFileSync(archive);
    const altered = Buffer.from(sealed); altered[altered.length - 1] ^= 1;
    fs.writeFileSync(archive, altered);
    await assert.rejects(() => writeReadableDocument(corrupt));
    assert(!fs.existsSync(filename(corrupt)));
    assert.deepEqual(fs.readdirSync(path.dirname(filename(corrupt))), []);
    fs.writeFileSync(archive, sealed);
    await assert.rejects(() => writeReadableDocument({ ...makeDoc(), id: '../escape' }));

    const repository = { save: async doc => doc, findOne: async () => null };
    const service = new DocumentsService(repository, {}, {}, {}, repository, {}, new EventEmitter(), {}, {});
    service.log = async () => {};
    const pending = { ...makeDoc(), status: 'pending' };
    await service.saveUploadedDocument(pending);
    assert(!fs.existsSync(filename(pending)));
    const privateDoc = { ...makeDoc(), status: 'stored' };
    await service.saveUploadedDocument(privateDoc);
    assert.deepEqual(fs.readFileSync(filename(privateDoc)), bytes);
    service.getOrFail = async () => pending;
    await service.approve(pending.id, { id: crypto.randomUUID(), role: 'admin' });
    assert.deepEqual(fs.readFileSync(filename(pending)), bytes);
    const failed = { ...makeDoc(), status: 'stored' };
    repository.save = async () => { throw Error('database failure'); };
    await assert.rejects(() => service.saveUploadedDocument(failed), /database failure/);
    assert(!fs.existsSync(filename(failed)));

    const manifest = { id: crypto.randomUUID(), documentId: second.id, requestId: crypto.randomUUID(), objects: [] };
    const journal = new Map([['manifest:' + manifest.id, manifest]]);
    const infrastructure = new LocalDestructionInfrastructure({}, {});
    infrastructure.settings = () => ({ targets: [], archive: process.env.UPLOAD_ARCHIVE_DIR });
    infrastructure.journal = () => ({ get: (kind, id) => journal.get(kind + ':' + id), put: (kind, id, value) => journal.set(kind + ':' + id, value) });
    infrastructure.currentDocument = async () => second;
    await infrastructure.destroy({ operationId: 'test', manifestId: manifest.id, documentId: second.id,
      requestId: manifest.requestId, manifestDigest: digest(manifest) });
    assert(!fs.existsSync(filename(second)));

    process.env.DOCUMENT_READABLE_DIR = process.env.UPLOAD_ARCHIVE_DIR;
    assert.throws(() => readableRoot(), /separate/);
    process.env.DOCUMENT_READABLE_DIR = '';
    assert.equal(await writeReadableDocument(makeDoc()), false);
    console.log('Readable copies: encrypted roundtrip, duplicates, integrity failures, approval, rollback and destruction passed.');
  } finally {
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
