// Readiness check and explicit local-state initialization. Never deletes document content.
require('dotenv').config();
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const database = require('../dist/config/typeorm.config').default;
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { DestructionInfrastructure } = require('../dist/destruction/destruction.infrastructure');
async function main() {
  const documentIndex = process.argv.indexOf('--document');
  const documentId = documentIndex >= 0 ? process.argv[documentIndex + 1] : null;
  if (documentIndex >= 0 && (process.argv.length !== 4 || documentIndex !== 2
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId || '')))
    throw Error('Usage: node scripts/check-destruction.cjs --document <document-uuid> (read-only).');
  const config = new ConfigService(process.env);
  if (process.argv.includes('--paths')) {
    // Paths only: never print the environment, SQL credentials, SMTP credentials or OTP secrets.
    for (const [key, fallback] of [
      ['UPLOAD_ARCHIVE_DIR', './storage/archive'], ['BACKUP_DIR', './storage/backup'],
      ['DESTRUCTION_LOCAL_CONFIG', ''], ['DESTRUCTION_STATE_DIR', './storage/destruction-state'],
      ['DESTRUCTION_BACKUP_STAGING_ROOT', './storage/destruction-backup-staging'],
    ]) {
      const value = process.env[key] || fallback;
      const resolved = value ? path.resolve(value) : '(not configured)';
      console.log(`${key}=${resolved} | exists=${!!value && fs.existsSync(resolved)}`);
    }
    return;
  }
  if (process.argv.includes('--init')) {
    if (!process.env.DESTRUCTION_LOCAL_CONFIG) throw Error('Set DESTRUCTION_LOCAL_CONFIG to the approved local policy JSON first.');
    const directories = [process.env.DESTRUCTION_STATE_DIR || './storage/destruction-state',
      process.env.DESTRUCTION_BACKUP_STAGING_ROOT || './storage/destruction-backup-staging'];
    for (const directory of directories) fs.mkdirSync(path.resolve(directory), { recursive: true, mode: 0o700 });
    // The provider validates disjoint, existing authoritative targets before writing any marker.
    const probe = new LocalDestructionInfrastructure(config, {});
    try { probe.initializeStorage(); } finally { probe.onModuleDestroy(); }
    console.log('Initialized protected local directories and backup target identities. No document content was changed.');
  }
  const ds = new DataSource({ ...database(), synchronize: false, migrationsRun: false, logging: false });
  await ds.initialize();
  if (documentId) {
    try {
      const { Document } = require('../dist/entities/document.entity');
      const { eligibilityReasons } = require('../dist/destruction/destruction.rules');
      if (typeof eligibilityReasons !== 'function') throw Error('Deploy updated source and run npm run build first.');
      const doc = await ds.manager.findOne(Document, { where: { id: documentId }, relations: ['documentType'] });
      if (!doc) throw Error('Document not found.');
      const reasons = eligibilityReasons(doc);
      if (!/^[a-f0-9]{64}$/i.test(doc.sha256Checksum || '')) reasons.push('Thiếu hoặc sai SHA-256 của file.');
      if (!(Number(doc.fileSizeBytes) >= 0)) reasons.push('Dung lượng file không hợp lệ.');
      console.log(`DOCUMENT: ${documentId} (read-only; no changes made)`);
      if (reasons.length) {
        reasons.forEach(reason => console.log(`BLOCKED: ${reason}`));
        process.exitCode = 1;
      } else console.log('ELIGIBLE: document metadata allows an early request; access, infrastructure, evidence and approvals are checked separately.');
    } finally { await ds.destroy(); }
    return;
  }
  const local = new LocalDestructionInfrastructure(config, ds);
  try {
    if (process.argv.includes('--list-sessions')) { console.table(local.sessions()); return; }
    const closeIndex = process.argv.indexOf('--close-backup-session');
    if (closeIndex >= 0) {
      const sessionId = process.argv[closeIndex + 1];
      if (!process.argv.includes('--confirm-stopped') || !/^[a-f0-9-]{36}$/i.test(sessionId || ''))
        throw Error('Verify the backup process has stopped, then use --close-backup-session <uuid> --confirm-stopped.');
      await local.call('backup/end', { sessionId, success: false });
      console.log('Closed the inspected stopped backup session as unsuccessful.'); return;
    }
    const backupIndex = process.argv.indexOf('--backup-journal');
    if (backupIndex >= 0) {
      await local.exportJournal(process.argv[backupIndex + 1] || '');
      console.log('Created a consistent protected SQLite journal backup.'); return;
    }
    for (const [flag, operation] of [['--resume-restore', 'restore/apply-tombstones'], ['--cancel-preparing-restore', 'restore/cancel-preparing']]) {
      const index = process.argv.indexOf(flag);
      if (index < 0) continue;
      const sessionId = process.argv[index + 1];
      if (!/^[a-f0-9-]{36}$/i.test(sessionId || '')) throw Error('A valid restore session UUID is required.');
      await local.call(operation, { sessionId });
      if (operation === 'restore/apply-tombstones') await local.call('restore/end', { sessionId, success: true });
      console.log('Restore session verified and closed.'); return;
    }
    const infra = new DestructionInfrastructure(config, local);
    if (infra.provider() === 'local') {
      const reasons = await local.diagnostics();
      if (reasons.length) { for (const reason of reasons) console.error(`NOT READY: ${reason}`); process.exitCode = 1; }
      else console.log('READY: direct storage, durable journal, SMTP, scanner, DB protections and configured active backup targets verified.');
    } else if (!await infra.health()) { console.error('NOT READY: gateway provider or DESTRUCTION_ENABLED.'); process.exitCode = 1; }
    else console.log('READY: infrastructure gateway verified.');
    console.log(`DESTRUCTION_ENABLED=${process.env.DESTRUCTION_ENABLED === 'true' ? 'true' : 'false'} (not modified)`);
  } finally { local.onModuleDestroy(); await ds.destroy(); }
}
main().catch(error => { console.error(error.getResponse?.()?.message || error.message); process.exitCode = 1; });
