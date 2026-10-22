// Real filesystem + SQLite WAL; all content stays in one generated temporary tree.
// MySQL, SMTP and scanner are test doubles; no real server, email or archive is touched.
require('reflect-metadata');
// This fixture deliberately exercises the explicitly enabled legacy-file transition mode.
process.env.ARCHIVE_ALLOW_LEGACY_READ = 'true';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { DestructionInfrastructure } = require('../dist/destruction/destruction.infrastructure');
const { safePath, LocalDestructionJournal, inside } = require('../dist/destruction/local-storage');
const { digest } = require('../dist/destruction/destruction.rules');
const { Document } = require('../dist/entities/document.entity');
const { User } = require('../dist/entities/user.entity');
const E = require('../dist/entities/destruction.entity');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = () => randomUUID();
let checks = 0;
async function denied(fn, status = 409) { await assert.rejects(fn, error => error.getStatus?.() === status); checks++; }
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-local-destruction-'));
  const archive = path.join(root, 'archive'), stateDir = path.join(root, 'state'), staging = path.join(root, 'staging');
  process.env.UPLOAD_ARCHIVE_DIR = archive;
  const targetKeys = ['external', 'cloud', 'nas'];
  const targets = targetKeys.map(key => ({ key, label: key, root: path.join(root, key), purgeWithinDays: 3, versioning: 'none', authoritative: true, notes: 'TEST ONLY' }));
  for (const directory of [archive, stateDir, staging, ...targets.map(t => t.root)]) fs.mkdirSync(directory);
  const policy = { version: 'test-local-v1', inventoryScope: 'database-files-only', targets };
  const configFile = path.join(root, 'policy.json'); fs.writeFileSync(configFile, JSON.stringify(policy));
  const config = new ConfigService({ DESTRUCTION_PROVIDER: 'local', DESTRUCTION_ENABLED: 'true', DESTRUCTION_LOCAL_CONFIG: configFile,
    UPLOAD_ARCHIVE_DIR: archive, DESTRUCTION_STATE_DIR: stateDir, DESTRUCTION_BACKUP_STAGING_ROOT: staging, DESTRUCTION_OTP_SECRET: 'test-only-secret-'.repeat(4) });
  config.set('BACKUP_DIR', targets[0].root);
  const now = new Date(), actor = { id: uuid(), role: 'admin', isActive: true, email: 'test@example.invalid' };
  let owners = [], versions = [], doc, request, job, item, held = false;
  const db = { options: { database: 'offline_test_only' }, manager: {
    findOne: async entity => entity === Document ? doc : entity === User ? actor : null,
    find: async entity => entity === Document ? [doc] : [],
    findOneBy: async (entity, where) => entity === User ? actor : entity === E.DestructionRequest ? request
      : entity === E.DestructionJob ? job : entity === E.DestructionItem ? item : null,
    findBy: async entity => entity === E.DestructionApproval ? [{ userId: actor.id, digest: request.digest }] : [],
    countBy: async () => 0,
    query: async sql => {
      if (sql.includes('UTC_TIMESTAMP')) return [{ now: new Date() }];
      if (sql.includes('max_allowed_packet')) return [{ bytes: 64 * 1024 * 1024 }];
      if (sql.includes('information_schema.TRIGGERS')) return require('../dist/migrations/1792368000000-DestructionWorkflow').DESTRUCTION_REQUIRED_TRIGGERS.map(TRIGGER_NAME => ({ TRIGGER_NAME }));
      if (sql.includes('d.storage_path AS filename')) return owners;
      if (sql.includes('AS filename')) return [];
      if (sql.includes('FROM document_versions')) return versions;
      throw Error('Unexpected offline query: ' + sql);
    },
  }, createQueryRunner: () => ({ connect: async () => {}, release: async () => {}, query: async sql => {
    if (sql.includes('GET_LOCK')) { assert.equal(held, false); held = true; return [{ acquired: 1 }]; }
    held = false; return [];
  } }) };
  const local = new LocalDestructionInfrastructure(config, db);
  const sent = [];
  local.command = async () => ({ stdout: 'offline scanner double' });
  local.mailer = () => ({ verify: async () => true, sendMail: async mail => { sent.push(mail); return { accepted: [actor.email] }; } });
  const infra = new DestructionInfrastructure(config, local);
  const filename = path.join(archive, 'original.pdf'), oldVersion = path.join(archive, 'version1.pdf');
  const bytes = Buffer.from('offline primary bytes'), versionBytes = Buffer.from('offline old version');
  fs.writeFileSync(filename, bytes); fs.writeFileSync(oldVersion, versionBytes);
  const bind = () => {
    request = { id: uuid(), status: 'processing', createdBy: uuid(), requiredApprovals: 1, digest: 'b'.repeat(64) };
    job = { requestId: request.id, status: 'processing', leaseOwner: uuid(), leaseExpiry: new Date(Date.now() + 3600000) };
    doc = { id: uuid(), file: { storageKey: filename }, storagePath: filename, sha256Checksum: sha(bytes), version: 2,
      status: 'stored', classificationValue: 'timed', retentionUntil: new Date(now.getTime() + 3650 * 86400000), legalHold: false,
      department: { id: 'dept-a' }, documentType: { isPermanent: false, retentionYears: 5, retentionBasis: 'document_date' },
      destructionRequestId: request.id, destructionStartedAt: now, destroyedAt: null };
    item = { snapshot: { checksum: sha(bytes), version: 2 } };
    versions = [{ storage_path: oldVersion, sha256_checksum: sha(versionBytes) }];
  };
  bind();
  try {
    assert.equal(infra.provider(), 'local');
    assert.equal(await infra.health(), null, 'No target identities may be assumed before init');
    local.initializeStorage(); local.healthCache = undefined;
    const capabilities = await infra.health(); assert.equal(capabilities.ready, true); assert.equal(capabilities.backupPolicy.targets.length, 3);
    const otp = '123456';
    const delivery = await local.call('otp/deliver', { actorId: actor.id, otp, challengeId: uuid(), expiresAt: new Date(Date.now() + 300000) });
    assert.equal(delivery.delivered, true); assert.equal(sent.length, 1);
    assert.equal(sent[0].to, actor.email); assert(sent[0].text.includes(otp));
    actor.role = 'department_head'; actor.department = { id: 'dept-a' };
    assert.equal((await local.call('otp/deliver', { actorId: actor.id, otp, challengeId: uuid(),
      expiresAt: new Date(Date.now() + 300000) })).delivered, true);
    actor.department.id = 'dept-b';
    await denied(() => local.currentDocument({ requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner }));
    actor.department.id = 'dept-a';
    assert.equal((await local.currentDocument({ requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner })).id, doc.id);
    const findScopedDocuments = db.manager.find;
    db.manager.find = async () => [doc, { ...doc, id: uuid(), department: { id: 'dept-b' } }];
    await denied(() => local.currentDocument({ requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner }));
    db.manager.find = findScopedDocuments;
    // The head may self-approve only ordinary records they uploaded.
    const originalCreator = request.createdBy;
    request.createdBy = actor.id; doc.uploader = { id: actor.id };
    assert.equal((await local.currentDocument({ requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner })).id, doc.id);
    doc.uploader.id = uuid();
    await denied(() => local.currentDocument({ requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner }));
    request.createdBy = originalCreator;
    // Sensitive content requires both roles at the final deletion fence.
    request.requiredApprovals = 2; doc.securityLevel = 'top_secret';
    const adminReviewer = { id: uuid(), role: 'admin', isActive: true };
    const findUser = db.manager.findOne, findVotes = db.manager.findBy;
    db.manager.findOne = async (entity, options) => entity === User && options.where.id === adminReviewer.id
      ? adminReviewer : findUser(entity, options);
    db.manager.findBy = async (entity, where) => entity === E.DestructionApproval
      ? [actor, adminReviewer].map(reviewer => ({ userId: reviewer.id, digest: request.digest })) : findVotes(entity, where);
    assert.equal((await local.currentDocument({ requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner })).id, doc.id);
    adminReviewer.role = 'department_head'; adminReviewer.department = { id: 'dept-a' };
    await denied(() => local.currentDocument({ requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner }));
    db.manager.findOne = findUser; db.manager.findBy = findVotes;
    request.requiredApprovals = 1; delete doc.securityLevel;
    assert.equal(infra.otpHash('challenge', otp).length, 64);
    for (const key of ['../outside.pdf', 'sub/../../outside.pdf', 'file:stream', '/absolute.pdf', 'sub\\escape.pdf']) {
      assert.throws(() => safePath(archive, key), e => e.getStatus() === 409); checks++;
    }
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.pdf'), bytes);
    try {
      fs.symlinkSync(outside, path.join(archive, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => safePath(archive, 'junction/secret.pdf'), e => e.getStatus() === 409); checks++;
    } finally { if (fs.existsSync(path.join(archive, 'junction'))) fs.unlinkSync(path.join(archive, 'junction')); }
    const payload = () => ({ requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner, snapshot: item.snapshot });
    const sharedOwnerId = uuid();
    owners = [{ documentId: sharedOwnerId, status: 'stored', filename }];
    assert.deepEqual(await local.inspectOwnership(doc.id, filename), {
      hardLinks: '1', references: [{ id: sharedOwnerId, status: 'stored' }],
    });
    await denied(() => local.call('content/inventory', payload()));
    owners = [];
    // Distinct NTFS file IDs must not collide through floating-point rounding.
    const realStat = fs.promises.stat;
    owners = [{ documentId: sharedOwnerId, status: 'stored', filename: oldVersion }];
    fs.promises.stat = async (file, options) => {
      assert.equal(options?.bigint, true);
      const stat = await realStat(file, options);
      return { ...stat, dev: 1n, ino: file === filename ? 9007199254740992n : 9007199254740993n };
    };
    try { assert.deepEqual((await local.inspectOwnership(doc.id, filename)).references, []); }
    finally { fs.promises.stat = realStat; owners = []; }
    const hard = path.join(root, 'hard.pdf'); fs.linkSync(filename, hard);
    assert.equal((await local.inspectOwnership(doc.id, filename)).hardLinks, '2');
    await denied(() => local.call('content/inventory', payload())); fs.unlinkSync(hard);
    doc.legalHold = true; await denied(() => local.call('content/inventory', payload())); doc.legalHold = false;
    await denied(() => local.call('content/inventory', { ...payload(), leaseOwner: uuid() }));
    const manifest = await local.call('content/inventory', payload()); assert.equal(manifest.objects.length, 2);
    const deletionPayload = { requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner,
      manifestId: manifest.id, manifestDigest: digest(manifest), operationId: uuid() };
    await denied(() => local.call('content/destroy', deletionPayload));
    for (const target of targets) {
      fs.writeFileSync(path.join(target.root, 'original.pdf'), bytes);
      fs.mkdirSync(path.join(target.root, 'old-backup'));
      fs.writeFileSync(path.join(target.root, 'old-backup', 'version1.pdf'), versionBytes);
      const exclusion = { requestId: request.id, documentId: doc.id, target: target.key, objects: manifest.objects,
        backupPolicy: capabilities.backupPolicy, operationId: digest([request.id, doc.id, target.key]) };
      const first = await local.call('backup/exclude', exclusion);
      assert.deepEqual(await local.call('backup/exclude', exclusion), first);
    }
    fs.writeFileSync(path.join(archive, 'keep.pdf'), 'keep me');
    const snapshot = await local.call('backup/begin', { operationId: uuid() });
    assert(fs.existsSync(path.join(snapshot.sourceDirectory, 'keep.pdf')));
    assert.equal(fs.existsSync(path.join(snapshot.sourceDirectory, 'original.pdf')), false);
    const purgePayload = { operationId: uuid(), requestId: request.id, documentId: doc.id, target: 'external', objects: manifest.objects };
    assert.equal((await local.call('backup/purge', purgePayload)).verifiedAbsent, false, 'Active backups must fence purge');
    await local.call('backup/end', { sessionId: snapshot.sessionId, success: true });
    assert.equal(fs.existsSync(snapshot.sourceDirectory), false, 'Closed temporary snapshots must not retain destroyed bytes');
    for (const target of targets) {
      assert.equal(fs.readFileSync(path.join(target.root, 'lths-managed', snapshot.sessionId, 'keep.pdf'), 'utf8'), 'keep me');
      assert.equal(fs.existsSync(path.join(target.root, 'lths-managed', snapshot.sessionId, 'original.pdf')), false);
    }
    config.set('RCLONE_REMOTES', 'unmanaged-cloud:files');
    await denied(() => local.call('backup/begin', { operationId: uuid() }), 503);
    config.set('RCLONE_REMOTES', '');
    // A modified hash must stop before either primary or version is deleted.
    fs.writeFileSync(filename, 'modified'); await denied(() => local.call('content/destroy', deletionPayload));
    assert(fs.existsSync(filename)); assert(fs.existsSync(oldVersion)); fs.writeFileSync(filename, bytes);
    // Simulate a crash exactly after unlink but before recording the per-object completion.
    const unlink = fs.promises.unlink;
    fs.promises.unlink = async value => {
      await unlink(value);
      if (value === filename) throw Error('SIMULATED_CRASH_AFTER_UNLINK');
    };
    try { await assert.rejects(() => local.call('content/destroy', deletionPayload), /SIMULATED_CRASH/); }
    finally { fs.promises.unlink = unlink; }
    assert.equal(fs.existsSync(filename), false); assert(fs.existsSync(oldVersion));
    local.onModuleDestroy();
    const resumed = new LocalDestructionInfrastructure(config, db);
    try {
      const receipt = await resumed.call('content/destroy', deletionPayload);
      assert.equal(receipt.verifiedAbsent, true); assert.equal(receipt.objects.length, 2);
      assert.equal(fs.existsSync(oldVersion), false);
      assert.deepEqual(await resumed.call('content/destroy', deletionPayload), receipt);
      for (const target of targets) {
        const result = await resumed.call('backup/purge', { ...purgePayload, operationId: uuid(), target: target.key });
        assert.equal(result.verifiedAbsent, true);
        assert.equal(fs.existsSync(path.join(target.root, 'original.pdf')), false);
        assert.equal(fs.existsSync(path.join(target.root, 'old-backup', 'version1.pdf')), false);
      }
      fs.writeFileSync(filename, bytes);
      await denied(() => resumed.call('content/destroy', deletionPayload)); fs.unlinkSync(filename);
      // Initial disappearance without a previously verified per-object intent must never count as success.
      bind(); fs.writeFileSync(filename, bytes); fs.writeFileSync(oldVersion, versionBytes);
      const secondManifest = await resumed.call('content/inventory', payload());
      for (const target of targets) await resumed.call('backup/exclude', { requestId: request.id, documentId: doc.id, target: target.key,
        objects: secondManifest.objects, backupPolicy: capabilities.backupPolicy, operationId: digest([request.id, doc.id, target.key]) });
      fs.unlinkSync(filename);
      await denied(() => resumed.call('content/destroy', { ...deletionPayload, requestId: request.id, documentId: doc.id, leaseOwner: job.leaseOwner,
        operationId: uuid(), manifestId: secondManifest.id, manifestDigest: digest(secondManifest) }));
      assert(fs.existsSync(oldVersion));
      // Markers bind backup targets to the original independent journal, not merely a folder name.
      const marker = path.join(targets[0].root, '.lths-destruction-target.json'); const markerBytes = fs.readFileSync(marker);
      fs.writeFileSync(marker, JSON.stringify({ key: 'external', policyVersion: policy.version, journalId: uuid() }));
      await denied(() => resumed.call('backup/purge', { ...purgePayload, operationId: uuid() }), 503);
      fs.writeFileSync(marker, markerBytes);
      policy.targets[1].versioning = 'hidden-cloud-revisions'; fs.writeFileSync(configFile, JSON.stringify(policy));
      assert.throws(() => resumed.settings(), e => e.getStatus() === 503); checks++;
      policy.targets[1].versioning = 'none'; fs.writeFileSync(configFile, JSON.stringify(policy));
      fs.writeFileSync(path.join(stateDir, 'maintenance.json'), '{}');
      await denied(() => resumed.call('content/inventory', payload()), 503);
      assert.equal((await resumed.call('health', {})).ready, false);
      fs.unlinkSync(path.join(stateDir, 'maintenance.json'));
      // A snapshot/export preparation error keeps maintenance; only an unstarted preparing session may cancel.
      await assert.rejects(() => resumed.call('restore/begin', { operationId: uuid() }));
      const maintenance = JSON.parse(fs.readFileSync(path.join(stateDir, 'maintenance.json'), 'utf8'));
      assert(maintenance.sessionId);
      await denied(() => resumed.call('restore/end', { sessionId: maintenance.sessionId, success: true }));
      assert(fs.existsSync(path.join(stateDir, 'maintenance.json')));
      await resumed.call('restore/cancel-preparing', { sessionId: maintenance.sessionId });
      assert.equal(fs.existsSync(path.join(stateDir, 'maintenance.json')), false);
    } finally { resumed.onModuleDestroy(); }
    // FULL SQLite snapshots preserve binary evidence and can be reopened independently of the MySQL fixture.
    const journal = new LocalDestructionJournal(stateDir);
    journal.put('binary-test', 'one', { bytes: Buffer.from([0, 255, 17]) }); journal.close();
    const reopened = new LocalDestructionJournal(stateDir);
    assert.deepEqual(reopened.get('binary-test', 'one').bytes, Buffer.from([0, 255, 17])); reopened.close();
    const exporter = new LocalDestructionInfrastructure(config, db);
    const backupFile = path.join(root, 'protected-journal-backup.sqlite');
    try {
      await exporter.exportJournal(backupFile);
      const { DatabaseSync } = require('node:sqlite');
      const exported = new DatabaseSync(backupFile, { readOnly: true });
      assert(exported.prepare("SELECT payload FROM records WHERE kind='binary-test'").get().payload.includes('AP8R'));
      exported.close();
      await denied(() => exporter.exportJournal(path.join(archive, 'unsafe.sqlite')), 422);
    } finally { exporter.onModuleDestroy(); }
    // An initialized deployment cannot forget existing targets by declaring them unused.
    const diskOnly = { ...policy, targets: [targets[0], ...targets.slice(1).map(t => ({
      key: t.key, label: `${t.key} unused`, enabled: false, root: '', purgeWithinDays: 0, notes: 'No copies on this destination (test fixture)',
    }))] };
    fs.writeFileSync(configFile, JSON.stringify(diskOnly));
    const existing = new LocalDestructionInfrastructure(config, db);
    try { assert.throws(() => existing.initializeStorage(), e => e.getResponse?.().code === 'TARGET_SET_CHANGED'); checks++; }
    finally { existing.onModuleDestroy(); }
    // Fresh local-only deployment: one actual mirror, no fictitious cloud/NAS receipts.
    const diskState = path.join(root, 'disk-state'), diskBackup = path.join(root, 'disk-backup');
    fs.mkdirSync(diskState); fs.mkdirSync(diskBackup);
    config.set('DESTRUCTION_STATE_DIR', diskState); config.set('BACKUP_DIR', diskBackup);
    diskOnly.targets[0] = { ...targets[0], root: diskBackup };
    fs.writeFileSync(configFile, JSON.stringify(diskOnly));
    const disk = new LocalDestructionInfrastructure(config, db);
    disk.command = local.command; disk.mailer = local.mailer;
    try {
      disk.initializeStorage();
      const health = await new DestructionInfrastructure(config, disk).health();
      assert.equal(health.ready, true); assert.equal(health.backupPolicy.targets.filter(t => t.enabled === false).length, 2);
      const snapshot = await disk.call('backup/begin', { operationId: uuid() });
      await disk.call('backup/end', { sessionId: snapshot.sessionId, success: true });
      assert(fs.existsSync(path.join(diskBackup, 'lths-managed', snapshot.sessionId, 'keep.pdf')));
      assert.equal(disk.journal().all('backup-receipt').length, 1);
      await denied(() => disk.call('backup/exclude', { target: 'cloud', backupPolicy: health.backupPolicy }), 409);
      const savedQuery = db.manager.query;
      db.manager.query = async sql => sql.includes('information_schema.TRIGGERS') ? [] : savedQuery(sql);
      try { assert((await disk.diagnostics()).some(reason => reason.includes('destruction_versions_delete'))); }
      finally { db.manager.query = savedQuery; }
    } finally { disk.onModuleDestroy(); }
    assert(fs.existsSync(path.join(archive, 'keep.pdf')));
    assert(fs.existsSync(path.join(outside, 'secret.pdf')));
    console.log(`PASS: direct provider with real temporary files/SQLite, OTP transport, three backup targets, crash recovery, leases, hard links, traversal, junctions, tombstones and maintenance (${checks} rejection cases).`);
    console.log('LIMIT: live MySQL locks, real SMTP/ClamAV and physical server/NAS mounts still require deployment checks.');
  } finally {
    // Resolve and bound the one generated test directory before recursive cleanup on Windows.
    const resolved = fs.realpathSync(root), temp = fs.realpathSync(os.tmpdir());
    if (!inside(temp, resolved) || !path.basename(resolved).startsWith('lths-local-destruction-')) throw Error('Unsafe test cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
