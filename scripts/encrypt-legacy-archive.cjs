// Explicit maintenance operation. Default is read-only plan; no database credentials are printed.
require('dotenv').config();
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const database = require('../dist/config/typeorm.config').default;
const { loadArchiveKeys, within, rawChecksum, archiveChecksum, encryptArchiveFile } = require('../dist/common/archive-crypto');
const apply = process.argv.includes('--apply');
const removePlaintext = process.argv.includes('--remove-plaintext');
const baselineMissing = process.argv.includes('--baseline-missing-checksums');
const definitions = [
  { table: 'files', path: 'storage_key', hash: 'file_hash', where: "NOT EXISTS (SELECT 1 FROM documents d WHERE d.file_id=files.id AND d.status='destroyed')" },
  { table: 'documents', path: 'storage_path', hash: 'sha256_checksum', where: "status != 'destroyed'" },
  { table: 'document_versions', path: 'storage_path', hash: 'sha256_checksum', where: "EXISTS (SELECT 1 FROM documents d WHERE d.id=document_versions.document_id AND d.status!='destroyed')" },
  { table: 'personal_files', path: 'storage_path', hash: 'sha256_checksum', where: '1=1' },
];
(async () => {
  if (process.env.ARCHIVE_ENCRYPTION_ENABLED === 'false') throw Error('Enable archive encryption before conversion.');
  loadArchiveKeys();
  const roots = [process.env.UPLOAD_ARCHIVE_DIR, process.env.UPLOAD_STAGING_DIR, process.env.PERSONAL_STORAGE_DIR]
    .filter(Boolean).map(root => fs.realpathSync(root));
  if (!roots.length) throw Error('Configure absolute storage roots.');
  if (apply) {
    const flag = path.join(process.env.DESTRUCTION_STATE_DIR || './storage/destruction-state', 'maintenance.json');
    if (!fs.existsSync(flag)) throw Error('Stop all API/worker/backup/import processes and create the maintenance flag before --apply.');
    if (!process.argv.includes('--processes-stopped')) throw Error('Confirm API/workers/backups/imports are stopped with --processes-stopped.');
  }
  const db = new DataSource({ ...database(), synchronize: false, logging: false, migrationsRun: false });
  await db.initialize();
  try {
    const [active] = await db.query("SELECT COUNT(*) AS n FROM documents WHERE destruction_request_id IS NOT NULL AND status!='destroyed'");
    if (Number(active.n)) throw Error('Resolve/withdraw all active destruction requests before migrating storage.');
    const groups = new Map();
    for (const def of definitions) for (const row of await db.query(`SELECT id,${def.path} AS filename,${def.hash} AS checksum FROM ${def.table} WHERE ${def.where}`)) {
      const filename = fs.realpathSync(row.filename);
      if (!roots.some(root => within(root, filename)) || fs.lstatSync(row.filename).isSymbolicLink()) throw Error('Source resolves outside configured storage roots or is a link.');
      const refs = groups.get(filename) || []; refs.push({ ...row, def }); groups.set(filename, refs);
    }
    let converted = 0, verified = 0;
    for (const [source, refs] of groups) {
      const handle = fs.openSync(source, 'r'), magic = Buffer.alloc(8);
      try { fs.readSync(handle, magic, 0, 8, 0); } finally { fs.closeSync(handle); }
      const hashes = [...new Set(refs.map(r => r.checksum).filter(Boolean))];
      if (hashes.length > 1) throw Error('Conflicting trusted checksums; stop and investigate before migration.');
      const expected = hashes[0];
      if (magic.toString() === 'LTHSAE01') {
        if (!expected) throw Error('Encrypted source has no trusted checksum.');
        await archiveChecksum(source, expected); verified++; continue;
      }
      const actual = await rawChecksum(source);
      if (expected && expected !== actual) throw Error('Legacy source checksum mismatch. Nothing is repaired automatically.');
      if (refs.some(r => !r.checksum) && !baselineMissing) throw Error('Missing checksum: verify provenance, then explicitly use --baseline-missing-checksums.');
      if (!apply) { converted++; continue; }
      const destination = path.join(path.dirname(source), `${randomUUID()}.lths`);
      await encryptArchiveFile(source, destination, actual);
      await archiveChecksum(destination, actual);
      try {
        await db.transaction(async m => {
          for (const ref of refs) {
            const [current] = await m.query(`SELECT ${ref.def.path} AS filename,${ref.def.hash} AS checksum FROM ${ref.def.table} WHERE id=? FOR UPDATE`, [ref.id]);
            if (!current || current.filename !== ref.filename || current.checksum !== ref.checksum) throw Error('Metadata changed during conversion.');
            await m.query(`UPDATE ${ref.def.table} SET ${ref.def.path}=?,${ref.def.hash}=? WHERE id=?`, [destination, actual, ref.id]);
          }
          await m.query('INSERT INTO audit_logs (id,action,metadata,created_at) VALUES (?,?,?,UTC_TIMESTAMP())',
            [randomUUID(), 'archive_encrypted', JSON.stringify({ references: refs.map(r => ({ table: r.def.table, id: r.id })), checksum: actual })]);
        });
      } catch (error) { await fs.promises.unlink(destination); throw error; }
      if (removePlaintext) {
        if (!roots.some(root => within(root, fs.realpathSync(source))) || await rawChecksum(source) !== actual) throw Error('Legacy source changed before removal.');
        await fs.promises.unlink(source);
      }
      converted++;
    }
    console.log(JSON.stringify({ applied: apply, plannedOrConverted: converted, encryptedVerified: verified, plaintextRemoved: apply && removePlaintext }));
    if (apply && !removePlaintext) console.log('Legacy plaintext remains on disk. Restrict access and remove it after verifying the conversion; reruns do not remove unreferenced orphan files.');
  } finally { await db.destroy(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
