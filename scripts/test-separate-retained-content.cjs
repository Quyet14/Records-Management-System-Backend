// Offline DB simulation with real files, encrypted containers and the real local deletion provider.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash, randomBytes } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { separateRetainedContent } = require('../dist/destruction/separate-retained-content');
const { archiveChecksum, encryptArchiveFile } = require('../dist/common/archive-crypto');
const { digest } = require('../dist/destruction/destruction.rules');
const { Document } = require('../dist/entities/document.entity');
const { User } = require('../dist/entities/user.entity');
const E = require('../dist/entities/destruction.entity');
const uuid = () => randomUUID();
async function scenario(encrypted, convertLegacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-separate-'));
  const archive = path.join(root, 'archive'), stateDir = path.join(root, 'state'), staging = path.join(root, 'staging');
  const targets = ['external', 'cloud', 'nas'].map(key => ({ key, root: path.join(root, key), label: key,
    purgeWithinDays: 3, versioning: 'none', authoritative: true, notes: 'TEST ONLY' }));
  for (const directory of [archive, stateDir, staging, ...targets.map(t => t.root)]) fs.mkdirSync(directory);
  const policy = { version: 'test-separate', inventoryScope: 'database-files-only', targets };
  const configFile = path.join(root, 'policy.json'); fs.writeFileSync(configFile, JSON.stringify(policy));
  const saved = Object.fromEntries(['UPLOAD_ARCHIVE_DIR', 'ARCHIVE_KEY_FILE', 'ARCHIVE_ENCRYPTION_ENABLED', 'ARCHIVE_ALLOW_LEGACY_READ'].map(k => [k, process.env[k]]));
  process.env.UPLOAD_ARCHIVE_DIR = archive;
  process.env.ARCHIVE_ENCRYPTION_ENABLED = encrypted || convertLegacy ? 'true' : 'false';
  process.env.ARCHIVE_ALLOW_LEGACY_READ = 'false';
  process.env.ARCHIVE_KEY_FILE = path.join(root, 'keyring.json');
  fs.writeFileSync(process.env.ARCHIVE_KEY_FILE, JSON.stringify({ current: 'test', keys: { test: randomBytes(32).toString('base64') } }), { mode: 0o600 });
  const bytes = Buffer.from('retained document content'), sha = createHash('sha256').update(bytes).digest('hex');
  const original = path.join(archive, encrypted ? 'shared.lths' : 'shared.pdf');
  const input = path.join(root, 'input.pdf'); fs.writeFileSync(input, bytes);
  if (encrypted) await encryptArchiveFile(input, original, sha); else fs.copyFileSync(input, original);
  const actor = { id: uuid(), role: 'admin', isActive: true };
  const request = { id: uuid(), status: 'failed', digest: 'a'.repeat(64), requiredApprovals: 1, createdBy: uuid() };
  const file = { id: uuid(), storageKey: original, fileHash: sha };
  const document = id => ({ id, file: structuredClone(file), storagePath: original, sha256Checksum: sha, version: 2,
    status: 'stored', destroyedAt: null, destructionRequestId: null, destructionStartedAt: null, legalHold: false,
    classificationValue: 'timed', retentionUntil: new Date('2020-01-01'), securityLevel: 'normal',
    documentType: { isPermanent: false, retentionYears: 5, retentionBasis: 'document_date' }, department: { id: 'dept' } });
  const destroy = document(uuid()), keep = document(uuid());
  destroy.destructionRequestId = request.id; destroy.destructionStartedAt = new Date();
  const item = { requestId: request.id, documentId: destroy.id, status: 'pending', executionResult: null,
    snapshot: { checksum: sha, version: 2, storagePath: original, fileId: file.id } };
  const job = { requestId: request.id, status: 'failed', leaseOwner: uuid(), leaseExpiry: new Date(Date.now() + 3600000) };
  let documents = [destroy, keep], audits = [], rollback = false, extra = [];
  let versions = [destroy, keep].map(doc => ({ id: uuid(), document_id: doc.id, storage_path: original, sha256_checksum: sha }));
  const m = {
    findOneBy: async (entity, where) => {
      if (entity === Document) return structuredClone(documents.find(d => d.id === where.id));
      if (entity === E.DestructionRequest) return request;
      if (entity === E.DestructionItem) return item;
      if (entity === E.DestructionJob) return job;
      if (entity === User) return actor;
      return null;
    },
    findOne: async (entity, options) => m.findOneBy(entity, options.where),
    find: async entity => entity === Document ? documents.filter(d => d.destructionRequestId === request.id) : [],
    findBy: async entity => entity === E.DestructionApproval ? [{ userId: actor.id, digest: request.digest }] : [],
    countBy: async () => 0,
    update: async (_entity, id, changes) => { Object.assign(documents.find(d => d.id === id), changes); },
    create: (_entity, data) => data,
    save: async (_entity, data) => { if (rollback) throw Error('simulated transaction failure'); audits.push(data); },
    query: async (sql, params = []) => {
      if (sql.includes('UTC_TIMESTAMP')) return [{ now: new Date() }];
      if (sql.startsWith('UPDATE document_versions')) {
        versions.find(v => v.id === params[1] && v.document_id === params[2]).storage_path = params[0]; return;
      }
      if (sql.includes('AS filename')) {
        if (sql.includes('FROM documents d LIMIT')) return [...documents.map(d => ({ documentId: d.id, status: d.status, filename: d.storagePath })), ...extra];
        if (sql.includes('JOIN files')) return documents.filter(d => d.file).map(d => ({ documentId: d.id, status: d.status, filename: d.file.storageKey }));
        if (sql.includes('FROM document_versions')) return versions.map(v => ({ documentId: v.document_id, status: 'stored', filename: v.storage_path }));
        return [];
      }
      if (sql.includes('FROM document_versions')) return versions.filter(v => v.document_id === params[0]);
      throw Error('Unexpected test SQL: ' + sql);
    },
  };
  const db = { manager: m, options: { database: 'offline' }, transaction: async (_isolation, operation) => {
    const snapshot = structuredClone({ documents, versions, audits });
    try { return await operation(m); } catch (e) { ({ documents, versions, audits } = snapshot); throw e; }
  }, createQueryRunner: () => ({ connect: async () => {}, release: async () => {},
    query: async sql => sql.includes('GET_LOCK') ? [{ acquired: 1 }] : [] }) };
  const local = new LocalDestructionInfrastructure(new ConfigService({ DESTRUCTION_LOCAL_CONFIG: configFile,
    UPLOAD_ARCHIVE_DIR: archive, DESTRUCTION_STATE_DIR: stateDir, DESTRUCTION_BACKUP_STAGING_ROOT: staging }), db);
  const opts = { destroyId: destroy.id, keepId: keep.id, actorId: actor.id, reason: 'Keep the stored record', apply: false };
  const originalBytes = fs.readFileSync(original), frozenItem = structuredClone(item);
  try {
    local.initializeStorage();
    const plan = await separateRetainedContent(db, local, opts);
    assert.equal(plan.objects, 1); assert.equal(plan.applied, false);
    assert.equal(plan.encryptLegacyObjects, convertLegacy ? 1 : 0);
    assert(!fs.existsSync(path.join(archive, 'retained'))); assert.equal(audits.length, 0);
    extra = [{ documentId: uuid(), status: 'stored', filename: original }];
    await assert.rejects(() => separateRetainedContent(db, local, { ...opts, apply: true }), e => e.getResponse?.().code === 'ADDITIONAL_SHARED_CONTENT');
    extra = [];
    actor.role = 'user';
    await assert.rejects(() => separateRetainedContent(db, local, { ...opts, apply: true }), e => e.getResponse?.().code === 'ADMIN_AND_REASON_REQUIRED');
    actor.role = 'admin';
    keep.legalHold = true; documents.find(d => d.id === keep.id).legalHold = true;
    await assert.rejects(() => separateRetainedContent(db, local, opts), e => e.getResponse?.().code === 'RETAINED_DOCUMENT_LOCKED');
    documents.find(d => d.id === keep.id).legalHold = false;
    item.executionResult = { manifest: {} };
    await assert.rejects(() => separateRetainedContent(db, local, opts), e => e.getResponse?.().code === 'DESTRUCTION_ALREADY_PREPARED');
    item.executionResult = null;
    fs.writeFileSync(original, Buffer.from('tampered bytes'));
    await assert.rejects(() => separateRetainedContent(db, local, { ...opts, apply: true }));
    assert.equal(documents.find(d => d.id === keep.id).storagePath, original);
    fs.writeFileSync(original, originalBytes);
    rollback = true;
    await assert.rejects(() => separateRetainedContent(db, local, { ...opts, apply: true }), /simulated transaction failure/);
    rollback = false;
    assert.equal(documents.find(d => d.id === keep.id).storagePath, original);
    assert.deepEqual(fs.readFileSync(original), originalBytes);
    const applied = await separateRetainedContent(db, local, { ...opts, apply: true });
    assert.equal(applied.applied, true); assert.equal(audits.length, 1);
    const retained = documents.find(d => d.id === keep.id);
    assert.equal(retained.status, 'stored'); assert.equal(retained.file, null);
    assert.notEqual(retained.storagePath, original);
    assert.equal(await archiveChecksum(retained.storagePath, sha), sha);
    if (convertLegacy) {
      assert.equal(path.extname(retained.storagePath), '.lths');
      assert.notDeepEqual(fs.readFileSync(retained.storagePath), originalBytes);
      assert.equal(process.env.ARCHIVE_ALLOW_LEGACY_READ, 'false');
      await assert.rejects(() => archiveChecksum(original, sha), /File cũ chưa mã hóa/);
    } else assert.deepEqual(fs.readFileSync(retained.storagePath), originalBytes);
    const retainedBytes = fs.readFileSync(retained.storagePath);
    assert.equal(versions.find(v => v.document_id === keep.id).storage_path, retained.storagePath);
    assert.equal(versions.find(v => v.document_id === destroy.id).storage_path, original);
    assert.deepEqual(item, frozenItem); assert.equal(request.status, 'failed'); assert.equal(job.status, 'failed');
    assert.equal((await separateRetainedContent(db, local, { ...opts, apply: true })).objects, 0);
    const retainedKey = path.relative(archive, retained.storagePath);
    for (const target of targets) {
      fs.copyFileSync(original, path.join(target.root, path.basename(original)));
      fs.mkdirSync(path.dirname(path.join(target.root, retainedKey)), { recursive: true });
      fs.copyFileSync(retained.storagePath, path.join(target.root, retainedKey));
    }
    // Requeue is an operator action; then use the real inventory, tombstones and destroy logic.
    request.status = 'processing'; job.status = 'processing';
    const payload = { requestId: request.id, documentId: destroy.id, leaseOwner: job.leaseOwner, snapshot: item.snapshot };
    const manifest = await local.call('content/inventory', payload);
    // Destruction looks up the deterministic per-target operation IDs.
    for (const target of targets) await local.call('backup/exclude', { operationId: digest([request.id, destroy.id, target.key]), requestId: request.id,
      documentId: destroy.id, target: target.key, objects: manifest.objects, backupPolicy: policy });
    const receipt = await local.call('content/destroy', { ...payload, operationId: uuid(), manifestId: manifest.id, manifestDigest: digest(manifest) });
    assert.equal(receipt.verifiedAbsent, true); assert.equal(fs.existsSync(original), false);
    assert.equal(await archiveChecksum(retained.storagePath, sha), sha);
    assert.deepEqual(fs.readFileSync(retained.storagePath), retainedBytes);
    for (const target of targets) {
      const purge = await local.call('backup/purge', { operationId: uuid(), requestId: request.id, documentId: destroy.id,
        target: target.key, objects: manifest.objects, purgeDueAt: new Date() });
      assert.equal(purge.verifiedAbsent, true);
      assert.equal(fs.existsSync(path.join(target.root, path.basename(original))), false);
      assert.deepEqual(fs.readFileSync(path.join(target.root, retainedKey)), retainedBytes);
    }
  } finally {
    local.onModuleDestroy();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    // The resolved temporary tree is the only cleanup target.
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
(async () => {
  await scenario(false); await scenario(true); await scenario(false, true);
  console.log('PASS: dry-run, admin/hold/checkpoint/additional-owner/tampering guards, rollback, repeat repair, plaintext/encrypted copies, versions, real deletion/backup purge and retained content integrity.');
  console.log('LIMIT: MySQL transactions/triggers are simulated; verify the plan and both documents on the deployment server.');
})().catch(error => { console.error(error); process.exitCode = 1; });
