// Real SQLite + temporary content; MySQL rows/DDL are simulated, never a live restore.
require('reflect-metadata');
process.env.ARCHIVE_ALLOW_LEGACY_READ = 'true';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { DataSource } = require('typeorm');
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { inside } = require('../dist/destruction/local-storage');
const { digest } = require('../dist/destruction/destruction.rules');
const { Document } = require('../dist/entities/document.entity');
const { DestructionItem } = require('../dist/entities/destruction.entity');
const { DestructionWorkflow1792368000000 } = require('../dist/migrations/1792368000000-DestructionWorkflow');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-restore-test-'));
  let provider;
  const originalMigration = DestructionWorkflow1792368000000.prototype.up;
  try {
    const entities = fs.readdirSync(path.join(__dirname, '../dist/entities')).filter(n => n.endsWith('.entity.js'))
      .flatMap(n => Object.values(require('../dist/entities/' + n)).filter(v => typeof v === 'function'));
    const metadata = new DataSource({ type: 'mysql', database: 'offline', entities }); await metadata.buildMetadatas();
    const archive = path.join(root, 'archive'), state = path.join(root, 'state'), staging = path.join(root, 'staging');
    process.env.UPLOAD_ARCHIVE_DIR = archive;
    const targets = ['external', 'cloud', 'nas'].map(key => ({ key, label: key, root: path.join(root, key),
      purgeWithinDays: 5, versioning: 'none', authoritative: true, notes: 'TEST ONLY' }));
    for (const directory of [archive, state, staging, ...targets.map(t => t.root)]) fs.mkdirSync(directory);
    const policy = { version: 'restore-policy', inventoryScope: 'database-files-only', targets };
    const configFile = path.join(root, 'policy.json'); fs.writeFileSync(configFile, JSON.stringify(policy));
    const config = new ConfigService({ DESTRUCTION_LOCAL_CONFIG: configFile, DESTRUCTION_STATE_DIR: state,
      DESTRUCTION_BACKUP_STAGING_ROOT: staging, UPLOAD_ARCHIVE_DIR: archive, BACKUP_DIR: targets[0].root });
    const documentId = randomUUID(), requestId = randomUUID(), attachmentId = randomUUID(), creator = randomUUID(), itemId = randomUUID();
    const now = new Date('2026-10-19T03:00:00.000Z');
    const bytes = Buffer.from('restored destroyed content'), evidence = Buffer.from([0, 255, 1, 17]);
    const checksum = createHash('sha256').update(bytes).digest('hex'), filename = path.join(archive, 'restored.pdf');
    const doc = { id: documentId, status: 'stored', storagePath: filename, file: { storageKey: filename },
      destructionRequestId: requestId, destructionStartedAt: null, destroyedAt: null };
    const tables = Object.fromEntries(metadata.entityMetadatas.map(m => [m.tableName, []]));
    tables.destruction_requests = [{ id: requestId, code: 'HUY-TEST', reason: 'Expired', decision_number: 'QD', decision_date: new Date('2026-10-19'),
      status: 'completed', created_by: creator, created_at: now, required_approvals: 1, execute_after: now, destroyed_at: now, completed_at: now,
      completed_by: creator, version: 5, digest: 'a'.repeat(64), backup_policy_snapshot: policy, backup_disposition_notes: 'TEST', failure_reason: null }];
    tables.destruction_items = [{ id: itemId, request_id: requestId, document_id: documentId,
      snapshot: { title: 'Preserved', checksum }, status: 'destroyed', checksum_at_destruction: checksum, destroyed_at: now, execution_result: { verified: true } }];
    tables.destruction_attachments = [{ id: attachmentId, request_id: requestId, type: 'decision', filename: 'decision.pdf', object_key: 'key',
      size: evidence.length, sha256: createHash('sha256').update(evidence).digest('hex'), uploaded_by: creator, created_at: now, signature_validation_result: { status: 'not_checked' } }];
    tables.destruction_attachment_content = [{ attachment_id: attachmentId, bytes: evidence }];
    tables.audit_logs = [{ id: randomUUID(), actor_id: creator, document_id: documentId, action: 'destruction', metadata: { requestId, description: 'Preserved audit' }, created_at: now }];
    let locked = false;
    const db = { options: { database: 'offline_restore' }, entityMetadatas: metadata.entityMetadatas,
      getMetadata: entity => metadata.getMetadata(entity), createQueryRunner: () => ({ release: async () => {}, connect: async () => {}, query: async sql => {
        if (sql.includes('GET_LOCK')) { assert.equal(locked, false); locked = true; return [{ acquired: 1 }]; }
        locked = false; return [];
      } }), manager: {
        countBy: async () => 0,
        findOne: async entity => entity === Document ? doc : null,
        findOneBy: async entity => entity === DestructionItem ? { status: tables.destruction_items[0].status, destroyedAt: tables.destruction_items[0].destroyed_at } : null,
        update: async (entity, _id, values) => { assert.equal(entity, Document); Object.assign(doc, values); },
        query: async (sql, values = []) => {
          if (sql.includes('FROM document_versions')) return [];
          if (sql.includes('AS filename')) return [];
          if (sql.startsWith('SELECT * FROM audit_logs')) return tables.audit_logs;
          const select = sql.match(/^SELECT \* FROM `([^`]+)`/);
          if (select) {
            const table = select[1];
            if (sql.includes('OFFSET')) return tables[table].slice(values[0], values[0] + 1);
            const primary = metadata.entityMetadatas.find(m => m.tableName === table).primaryColumns[0].databaseName;
            return tables[table].filter(row => row[primary] === values[0]);
          }
          const write = sql.match(/^(INSERT INTO|UPDATE) `([^`]+)`/);
          if (write) {
            const table = write[2], definition = metadata.entityMetadatas.find(m => m.tableName === table);
            const columns = write[1] === 'INSERT INTO' ? sql.match(/\(([^)]+)\)/)[1].split(',').map(c => c.replace(/`/g, ''))
              : sql.split(' SET ')[1].split(' WHERE ')[0].split(',').map(c => c.split('=')[0].replace(/`/g, ''));
            const row = Object.fromEntries(columns.map((column, i) => {
              const type = definition.columns.find(c => c.databaseName === column)?.type;
              let value = values[i];
              if (type === 'json' && typeof value === 'string') value = JSON.parse(value);
              if (type === 'date' && typeof value === 'string') value = new Date(value);
              return [column, value];
            }));
            if (write[1] === 'INSERT INTO') tables[table].push(row);
            else {
              const primary = definition.primaryColumns[0].databaseName;
              const existing = tables[table].find(r => r[primary] === values[values.length - 1]); Object.assign(existing, row);
            }
            return [];
          }
          throw Error('Unexpected restore query: ' + sql);
        },
      } };
    provider = new LocalDestructionInfrastructure(config, db); provider.initializeStorage();
    const manifest = { id: randomUUID(), requestId, documentId, objects: [{ key: 'restored.pdf', sha256: checksum }] };
    provider.journal().put('manifest', manifest.id, manifest);
    for (const target of targets) await provider.call('backup/exclude', { operationId: digest([requestId, documentId, target.key]),
      requestId, documentId, target: target.key, objects: manifest.objects, backupPolicy: policy });
    const session = await provider.call('restore/begin', { operationId: randomUUID() });
    assert(provider.maintenance());
    // Simulate importing an older dump while the maintenance flag remains active.
    tables.destruction_requests[0] = { ...tables.destruction_requests[0], status: 'pending', version: 1, destroyed_at: null, completed_at: null };
    tables.destruction_items[0] = { ...tables.destruction_items[0], status: 'pending', destroyed_at: null };
    tables.audit_logs = [];
    tables.destruction_attachment_content[0] = { attachment_id: attachmentId, bytes: Buffer.from('CORRUPT immutable evidence') };
    fs.writeFileSync(filename, bytes);
    // DDL is covered by migration metadata tests; this suite focuses on protected replay and filesystem effects.
    DestructionWorkflow1792368000000.prototype.up = async () => {};
    await assert.rejects(() => provider.call('restore/apply-tombstones', { sessionId: session.sessionId }), e => e.getStatus() === 409);
    assert(provider.maintenance()); assert(fs.existsSync(filename));
    assert.equal(tables.destruction_attachment_content[0].bytes.toString(), 'CORRUPT immutable evidence');
    // An operator repairs the missing/corrupt row, then resumes; the protected original is inserted atomically by the DB.
    tables.destruction_attachment_content = [];
    const verified = await provider.call('restore/apply-tombstones', { sessionId: session.sessionId });
    assert.equal(verified.applied, true); assert.equal(verified.verified, true);
    assert.equal(tables.destruction_requests[0].status, 'completed'); assert.equal(tables.destruction_requests[0].version, 5);
    assert.equal(tables.destruction_items[0].status, 'destroyed');
    assert(tables.destruction_requests[0].created_at instanceof Date);
    assert.deepEqual(tables.destruction_attachment_content[0].bytes, evidence);
    assert.equal(tables.audit_logs.length, 1); assert.equal(tables.audit_logs[0].metadata.description, 'Preserved audit');
    assert.equal(fs.existsSync(filename), false); assert.equal(doc.status, 'destroyed');
    assert(provider.maintenance(), 'Verification alone must not publish restored data');
    await provider.call('restore/end', { sessionId: session.sessionId, success: true });
    assert.equal(provider.maintenance(), false);
    console.log('PASS: native restore preserves evidence/audit, repairs mutable workflow state, rejects immutable conflicts, replays tombstones and only then releases maintenance.');
    console.log('LIMIT: SQL storage and DDL are simulated; real MySQL restore/grants remain deployment acceptance checks.');
  } finally {
    DestructionWorkflow1792368000000.prototype.up = originalMigration;
    provider?.onModuleDestroy();
    const target = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    if (!inside(parent, target) || !path.basename(target).startsWith('lths-restore-test-')) throw Error('Unsafe restore-test cleanup');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
