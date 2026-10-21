// Isolated files and fakes only. No live DB, mail, antivirus or archive is used.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PDFDocument } = require('pdf-lib');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const C = require('../dist/common/archive-crypto');
const { inspectUpload } = require('../dist/common/upload-inspection');
const { WatermarkService } = require('../dist/common/watermark/watermark.service');
const { DocumentsService } = require('../dist/documents/documents.service');
const { DocumentAccessGuard } = require('../dist/common/guards/document-access.guard');
const { JwtAuthGuard } = require('../dist/common/guards/jwt-auth.guard');
const { ProfileSecurityAuthGuard, RecentAuthGuard } = require('../dist/common/guards/recent-auth.guard');
const { IpWhitelistGuard } = require('../dist/common/guards/ip-whitelist.guard');
const { JwtStrategy } = require('../dist/auth/jwt.strategy');
const { DatabaseThrottleStorage, SecurityModule } = require('../dist/security/security.module');
const { Global, Module, Controller, Get } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { DataSource } = require('typeorm');
const helmet = require('helmet');
const { requestAuditMiddleware, AuditContextSubscriber } = require('../dist/security/request-audit');
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { SystemService } = require('../dist/system/system.service');
const { PersonalFile } = require('../dist/entities/personal-file.entity');
const { SecurityHardening1792540800000 } = require('../dist/migrations/1792540800000-SecurityHardening');
const { digest } = require('../dist/destruction/destruction.rules');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ctx = req => ({ switchToHttp: () => ({ getRequest: () => req }) });
let checks = 0;
const reject = async (fn, status) => { await assert.rejects(fn, error => !status || error.getStatus?.() === status); checks++; };

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-security-'));
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = 'test'; process.env.ARCHIVE_ENCRYPTION_ENABLED = 'true';
    process.env.ARCHIVE_ALLOW_LEGACY_READ = 'false'; process.env.UPLOAD_SCAN_ENABLED = 'false';
    const archive = path.join(root, 'archive'); fs.mkdirSync(archive);
    process.env.UPLOAD_ARCHIVE_DIR = archive;
    const staging = path.join(root, 'staging'); fs.mkdirSync(staging); process.env.UPLOAD_STAGING_DIR = staging;
    process.env.ARCHIVE_KEY_FILE = path.join(root, 'keys.json');
    const key = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(process.env.ARCHIVE_KEY_FILE, JSON.stringify({ current: 'k1', keys: { k1: key } }), { mode: 0o600 });
    C.loadArchiveKeys();
    for (const length of [0, 1, 1024 * 1024, 1024 * 1024 + 7, 2 * 1024 * 1024]) {
      const bytes = crypto.randomBytes(length), source = path.join(root, 'input'), destination = path.join(archive, `${crypto.randomUUID()}.lths`);
      fs.writeFileSync(source, bytes);
      await C.encryptArchiveFile(source, destination, sha(bytes));
      assert.equal(await C.archiveChecksum(destination, sha(bytes)), sha(bytes));
      assert.deepEqual(await C.readArchiveBuffer(destination, sha(bytes)), bytes);
      const sealed = fs.readFileSync(destination);
      assert.notDeepEqual(sealed, bytes);
      await reject(() => C.archiveChecksum(destination, 'f'.repeat(64)), 409);
      for (const mutate of [
        value => { value[40] ^= 1; return value; },
        value => { value[96] ^= 1; return value; },
        value => value.subarray(0, value.length - 1),
        value => Buffer.concat([value, Buffer.from('extra')]),
      ]) {
        fs.writeFileSync(destination, mutate(Buffer.from(sealed)));
        await reject(() => C.archiveChecksum(destination, sha(bytes)), 409);
      }
      fs.writeFileSync(destination, sealed);
      if (length > 1024 * 1024) {
        const reordered = Buffer.from(sealed), block = 1024 * 1024 + 16;
        // Replacing a chunk with another chunk must not authenticate at the new index.
        sealed.copy(reordered, 96, 96 + block, Math.min(sealed.length, 96 + 2 * block));
        fs.writeFileSync(destination, reordered); await reject(() => C.archiveChecksum(destination, sha(bytes)), 409);
        fs.writeFileSync(destination, sealed);
      }
      const wrongDest = path.join(archive, `${crypto.randomUUID()}.lths`);
      await reject(() => C.encryptArchiveFile(source, wrongDest, '0'.repeat(64)), 409);
      assert.equal(fs.existsSync(wrongDest), false); assert.equal(fs.existsSync(wrongDest + '.partial'), false);
    }
    const pdf = await PDFDocument.create(); pdf.addPage(); const pdfBytes = Buffer.from(await pdf.save());
    const source = path.join(staging, 'valid.pdf'), destination = path.join(archive, `${crypto.randomUUID()}.lths`);
    fs.writeFileSync(source, pdfBytes);
    const upload = { path: source, originalname: 'test.pdf', size: pdfBytes.length, mimetype: 'application/pdf' };
    await inspectUpload(upload);
    fs.writeFileSync(source, 'not a PDF'); await reject(() => inspectUpload({ ...upload, size: 9 }), 400);
    fs.writeFileSync(source, '%PDF- fake'); await reject(() => inspectUpload({ ...upload, size: 10 }), 400);
    fs.writeFileSync(source, pdfBytes);
    process.env.UPLOAD_SCAN_ENABLED = 'true'; delete process.env.UPLOAD_CLAMAV_PATH;
    await reject(() => inspectUpload(upload), 503);
    process.env.UPLOAD_SCAN_ENABLED = 'false';
    process.env.NODE_ENV = 'production'; await reject(() => inspectUpload(upload), 503);
    process.env.NODE_ENV = 'test';
    await C.encryptArchiveFile(source, destination, sha(pdfBytes));
    const { secureImportFile, buildArchivePath } = require('./data-pipeline');
    const invalidSource = path.join(staging, 'invalid.pdf'), invalidDestination = path.join(archive, 'invalid.lths');
    fs.writeFileSync(invalidSource, 'not a PDF');
    await assert.rejects(() => secureImportFile(invalidSource, invalidDestination, sha(Buffer.from('not a PDF')), fs.statSync(invalidSource)),
      error => error.message.includes('invalid.pdf') && error.cause?.getStatus?.() === 400);
    assert.equal(fs.existsSync(invalidDestination), false);
    const importedPath = buildArchivePath(source, crypto.randomUUID(), new Date());
    assert(/^[0-9a-f-]{36}\.lths$/.test(path.basename(importedPath)));
    await secureImportFile(source, importedPath, sha(pdfBytes), fs.statSync(source));
    assert.deepEqual(await C.readArchiveBuffer(importedPath, sha(pdfBytes)), pdfBytes);
    const pendingImported = { id: crypto.randomUUID(), status: 'pending', securityLevel: 'normal',
      originalFilename: 'import.pdf', storagePath: importedPath, sha256Checksum: sha(pdfBytes), fileSizeBytes: pdfBytes.length };
    const importerApproval = Object.assign(Object.create(DocumentsService.prototype), {
      getOrFail: async () => pendingImported, filesRepo: { create: value => value, save: async value => ({ ...value, id: crypto.randomUUID() }) },
      docsRepo: { save: async value => value, findOne: async () => null }, userRepo: { findOne: async () => null },
      appendDayLog() {}, log: async () => {}, eventEmitter: { emit() {} },
    });
    const approvedImport = await importerApproval.approve(pendingImported.id, { id: 'admin', role: 'admin' });
    assert.equal(approvedImport.status, 'stored');
    assert.deepEqual(await C.readArchiveBuffer(approvedImport.storagePath, sha(pdfBytes)), pdfBytes);
    const again = path.join(archive, `${crypto.randomUUID()}.lths`);
    await C.encryptArchiveFile(source, again, sha(pdfBytes));
    assert.notDeepEqual(fs.readFileSync(destination), fs.readFileSync(again), 'Per-file keys/salts must randomize identical content');
    const watermark = new WatermarkService();
    const marked = await watermark.embedWatermark(await C.readArchiveBuffer(destination, sha(pdfBytes)), { userName: 'Nguyễn Văn A', userEmail: 'a@example.test' });
    assert.equal((await PDFDocument.load(marked)).getPageCount(), 1); assert.notDeepEqual(marked, pdfBytes);
    await reject(() => watermark.embedWatermark(Buffer.from('bad pdf'), { userName: 'A', userEmail: '' }));
    await reject(() => C.archiveChecksum(source, sha(pdfBytes)), 503);
    process.env.ARCHIVE_ALLOW_LEGACY_READ = 'true';
    assert.equal(await C.archiveChecksum(source, sha(pdfBytes)), sha(pdfBytes));
    process.env.ARCHIVE_ALLOW_LEGACY_READ = 'false';
    const ring = process.env.ARCHIVE_KEY_FILE;
    process.env.ARCHIVE_KEY_FILE = path.join(archive, 'keys.json'); fs.copyFileSync(ring, process.env.ARCHIVE_KEY_FILE);
    assert.throws(() => C.loadArchiveKeys()); process.env.ARCHIVE_KEY_FILE = ring;
    await reject(() => C.archiveChecksum(ring), 409);

    // Expired viewing grants never get extended by a pending extension request.
    const document = { id: crypto.randomUUID(), uploader: { id: 'owner' }, department: { id: 'a' }, securityLevel: 'normal', status: 'stored' };
    let expires = new Date(Date.now() - 1000), predicates = [];
    const qb = { where() { return this; }, andWhere(sql) { predicates.push(sql); return this; }, orderBy() { return this; },
      getOne: async () => predicates.some(sql => typeof sql === 'string' && sql.includes('access_expires_at >')) && expires > new Date()
        ? { accessExpiresAt: expires } : null };
    const guard = new DocumentAccessGuard({ findOne: async () => document }, { createQueryBuilder: () => qb });
    const user = { id: crypto.randomUUID(), role: 'user', departmentId: 'b', permissions: [], sessionId: crypto.randomUUID() };
    await reject(() => guard.canActivate(ctx({ user, params: { id: document.id } })), 403);
    assert.equal(predicates.some(sql => typeof sql === 'string' && sql.includes('EXISTS')), false);
    expires = new Date(Date.now() + 30000); predicates = [];
    const req = { user, params: { id: document.id } }; assert.equal(await guard.canActivate(ctx(req)), true);
    assert.equal(req.viewAccessExpiresAt, expires);
    const jwt = new JwtService({ secret: 'test-only-secret'.repeat(4) });
    const service = Object.assign(Object.create(DocumentsService.prototype), { jwtService: jwt, log: async () => {} });
    const link = await service.createViewUrl(document, user, expires), payload = jwt.verify(new URL(link.url, 'http://test').searchParams.get('token'));
    assert.equal(payload.sub, user.id); assert.equal(payload.sid, user.sessionId); assert.equal(payload.fileId, document.id);
    assert.equal(payload.type, 'file-view'); assert(link.expiresIn <= 30 && link.expiresIn > 0);
    await reject(() => service.createViewUrl(document, user, new Date(Date.now() - 100)), 403);
    const tokenGuard = new JwtAuthGuard();
    const tokenUser = { id: user.id, tokenType: 'file-view', fileId: document.id };
    const viewReq = { method: 'GET', params: { id: document.id }, route: { path: '/documents/:id/view' } };
    assert.equal(tokenGuard.handleRequest(null, tokenUser, null, ctx(viewReq)), tokenUser);
    for (const changed of [{ route: { path: '/documents/:id/download' } }, { params: { id: crypto.randomUUID() } }, { route: { path: '/documents/:id' } }])
      assert.throws(() => tokenGuard.handleRequest(null, tokenUser, null, ctx({ ...viewReq, ...changed })), error => error.getStatus?.() === 401);
    const recent = new RecentAuthGuard();
    assert.equal(recent.canActivate(ctx({ user: { ...user, authTime: Date.now() / 1000 } })), true);
    assert.throws(() => recent.canActivate(ctx({ user: { ...user, authTime: Date.now() / 1000 - 301 } })), error => error.getStatus?.() === 403);
    const profileGuard = new ProfileSecurityAuthGuard();
    assert.equal(profileGuard.canActivate(ctx({ user, body: { fullName: 'Profile name' } })), true);
    assert.throws(() => profileGuard.canActivate(ctx({ user, body: { email: 'new@example.test' } })), error => error.getStatus?.() === 403);
    assert.throws(() => profileGuard.canActivate(ctx({ user, body: { departmentId: 'other' } })), error => error.getStatus?.() === 403);
    process.env.IP_WHITELIST = '10.0.0.1/32';
    const whitelist = new IpWhitelistGuard(new ConfigService());
    assert.equal(whitelist.canActivate(ctx({ ip: '10.0.0.1', headers: {} })), true);
    assert.throws(() => whitelist.canActivate(ctx({ ip: '10.0.0.2', headers: { 'x-forwarded-for': '10.0.0.1' } })), error => error.getStatus?.() === 403);
    const archiveView = Object.assign(Object.create(DocumentsService.prototype), { getOrFail: async () => ({ ...document, originalFilename: 'file.zip' }) });
    await reject(() => archiveView.getFileForView(document, user), 403);

    // Destruction hashes plaintext against the approved snapshot, ciphertext against manifest/checkpoint.
    const snapshot = { checksum: sha(pdfBytes), version: 1 };
    const local = Object.assign(Object.create(LocalDestructionInfrastructure.prototype), {
      currentDocument: async () => ({ id: document.id, version: 1, sha256Checksum: sha(pdfBytes), storagePath: destination }),
      settings: () => ({ archive }), ownership: async () => {}, journal: () => ({ put() {} }),
      db: { manager: { findOneBy: async () => ({ snapshot }), query: async () => [] } },
    });
    const manifest = await local.inventory({ documentId: document.id, requestId: 'r', snapshot });
    assert.equal(manifest.primaryChecksum, sha(pdfBytes));
    assert.equal(manifest.objects[0].sha256, await C.rawChecksum(destination));
    assert.notEqual(manifest.objects[0].sha256, manifest.primaryChecksum);

    const logs = [], auditDb = { getRepository: () => ({ insert: async entry => logs.push(entry) }) };
    const response = Object.assign(new EventEmitter(), { statusCode: 403, writableFinished: true });
    const auditReq = { ip: '127.0.0.1', method: 'GET', route: { path: '/documents/:id/view' }, path: '/documents/id/view',
      params: { id: document.id }, user, query: { token: 'do-not-log' }, body: { password: 'do-not-log' } };
    let semantic;
    requestAuditMiddleware(auditDb)(auditReq, response, () => {
      semantic = { entity: { metadata: { result: 'success' } } }; new AuditContextSubscriber().beforeInsert(semantic);
    });
    response.emit('finish'); response.emit('close'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.length, 1); assert.equal(logs[0].metadata.result, 'failure');
    assert.equal(logs[0].actor.id, user.id); assert.equal(semantic.entity.metadata.ip, '127.0.0.1');
    assert.equal(JSON.stringify(logs).includes('do-not-log'), false);

    // Two limiter instances share the same transactional store; concurrency cannot bypass the limit.
    let bucket = { hits: 0, expires_ms: 0, blocked_ms: 0 }, tail = Promise.resolve(), clock = Date.now();
    const manager = { query: async (sql, params) => {
      if (sql.startsWith('SELECT')) return [{ ...bucket, now_ms: clock }];
      if (sql.startsWith('UPDATE')) bucket = { hits: params[0], expires_ms: params[1], blocked_ms: params[2] };
      return [];
    } };
    const db = { transaction: work => { const result = tail.then(() => work(manager)); tail = result.catch(() => {}); return result; } };
    const a = new DatabaseThrottleStorage(db), b = new DatabaseThrottleStorage(db);
    const increments = await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? a : b).increment('same', 60000, 5, 60000, 'auth')));
    assert.equal(increments.filter(result => !result.isBlocked).length, 5);
    clock += 60001; assert.equal((await a.increment('same', 60000, 5, 60000, 'auth')).isBlocked, false);

    // Real InnoDB deadlocks are transient: retry only rolled-back transactions,
    // and fail closed after the retry budget or on schema/connection errors.
    let attempts = 0, committedHits = bucket.hits;
    const recovered = new DatabaseThrottleStorage({ transaction: async work => {
      attempts++;
      if (attempts <= 2) throw { driverError: { errno: 1213, code: 'ER_LOCK_DEADLOCK' } };
      return work(manager);
    } });
    const recoveredResult = await recovered.increment('same', 60000, 5, 60000, 'global');
    assert.equal(attempts, 3); assert.equal(recoveredResult.totalHits, committedHits + 1);
    for (const driverError of [{ errno: 1213, code: 'ER_LOCK_DEADLOCK' }, { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' },
      { errno: 1146, code: 'ER_NO_SUCH_TABLE' }, { code: 'ECONNRESET' }]) {
      let failedAttempts = 0;
      const unavailable = new DatabaseThrottleStorage({ transaction: async () => { failedAttempts++; throw { driverError }; } });
      unavailable.logger = { error() {} };
      await assert.rejects(() => unavailable.increment('same', 60000, 5, 60000, 'global'), error => error.getStatus?.() === 503
        && error.getResponse().code === 'RATE_LIMIT_STORAGE_UNAVAILABLE');
      assert.equal(failedAttempts, driverError.errno === 1213 ? 3 : 1);
    }

    // Exercise real Nest module wiring, global guard, headers and HTTP 429 handling.
    const buckets = new Map(); let queue = Promise.resolve(), limiterFailure = null, handlerCalls = 0;
    const sqlManager = { query: async (sql, params) => {
      if (sql.startsWith('INSERT')) {
        assert(sql.includes('ON DUPLICATE KEY UPDATE'), 'The shared-lock INSERT IGNORE pattern must not return');
        if (!buckets.has(params[0])) buckets.set(params[0], { hits: 0, expires_ms: 0, blocked_ms: 0 });
      }
      else if (sql.startsWith('SELECT')) return [{ ...buckets.get(params[0]), now_ms: Date.now() }];
      else if (sql.startsWith('UPDATE')) buckets.set(params[3], { hits: params[0], expires_ms: params[1], blocked_ms: params[2] });
      return [];
    } };
    const sharedDb = { transaction: work => { const result = queue.then(() => {
      if (limiterFailure) throw limiterFailure;
      return work(sqlManager);
    }); queue = result.catch(() => {}); return result; } };
    class TestDatabaseModule {}
    Global()(TestDatabaseModule);
    Module({ providers: [{ provide: DataSource, useValue: sharedDb }], exports: [DataSource] })(TestDatabaseModule);
    class ProbeController { probe() { handlerCalls++; return { ok: true }; } }
    Controller('auth')(ProbeController); Get('probe')(ProbeController.prototype, 'probe', Object.getOwnPropertyDescriptor(ProbeController.prototype, 'probe'));
    class TestApplication {}
    Module({ imports: [TestDatabaseModule, SecurityModule], controllers: [ProbeController] })(TestApplication);
    const app = await NestFactory.create(TestApplication, { logger: false });
    try {
      app.use(helmet()); await app.listen(0, '127.0.0.1');
      const url = `http://127.0.0.1:${app.getHttpServer().address().port}/auth/probe`;
      for (let index = 0; index < 21; index++) {
        const response = await fetch(url);
        assert.equal(response.status, index < 20 ? 200 : 429);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        await response.text();
      }
      assert.equal(handlerCalls, 20);
      limiterFailure = { driverError: { errno: 1213, code: 'ER_LOCK_DEADLOCK' } };
      const failedResponse = await fetch(url);
      assert.equal(failedResponse.status, 503);
      assert.equal((await failedResponse.json()).code, 'RATE_LIMIT_STORAGE_UNAVAILABLE');
      assert.equal(handlerCalls, 20, 'A failed limiter must not allow access to the handler');
    } finally { await app.close(); }

    const auditEntries = [];
    const system = Object.assign(Object.create(SystemService.prototype), {
      docRepo: { find: async () => [
        { id: 'good', sha256Checksum: sha(pdfBytes), storagePath: destination, originalFilename: 'a.pdf' },
        { id: 'missing-hash', storagePath: destination, originalFilename: 'b.pdf' },
      ] }, dataSource: { getRepository: entity => ({ find: async () => entity === PersonalFile ? [{ id: 'personal', originalFilename: 'p.pdf', storagePath: again, sha256Checksum: sha(pdfBytes) }] : [] }) },
      auditRepo: { create: value => value, save: async value => auditEntries.push(value) }, logger: { warn() {} },
    });
    const integrity = await system.verifyChecksums();
    assert.equal(integrity.results.length, 3); assert.equal(integrity.errors, 1);
    assert.equal(auditEntries[0].metadata.result, 'failure');
    const queries = [];
    const migration = new SecurityHardening1792540800000();
    await migration.up({ hasTable: async () => true, hasColumn: async () => true,
      query: async sql => { queries.push(sql); return []; } });
    assert(queries.some(sql => sql.includes('BEFORE UPDATE ON audit_logs') && sql.includes('AUDIT_APPEND_ONLY')));
    assert(queries.some(sql => sql.includes('BEFORE DELETE ON audit_logs') && sql.includes('AUDIT_APPEND_ONLY')));
    console.log(`PASS: AES-GCM boundary cases/tampering, upload inspection, mandatory watermark, view grant/token scope, ciphertext destruction inventory, audit context, shared throttling and periodic integrity (${checks} rejection cases).`);
    console.log('LIMIT: live MySQL triggers/locking, real ClamAV, reverse proxy TLS and browser embedding require deployment acceptance.');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    const resolved = path.resolve(root), tempRoot = path.resolve(os.tmpdir());
    if (!resolved.startsWith(tempRoot + path.sep) || !path.basename(resolved).startsWith('lths-security-')) throw Error('Unsafe test cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
