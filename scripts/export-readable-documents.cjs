// Export approved documents without starting the API. Default: list/count only.
require('dotenv').config();
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const database = require('../dist/config/typeorm.config').default;
const { Document } = require('../dist/entities/document.entity');
const { readableRoot, writeReadableDocument } = require('../dist/common/readable-copy');

(async () => {
  if (!readableRoot()) throw Error('Set DOCUMENT_READABLE_DIR before exporting.');
  const apply = process.argv.includes('--apply');
  if (apply && !process.argv.includes('--processes-stopped'))
    throw Error('Stop API/workers/imports, then run: npm run documents:export-readable -- --apply --processes-stopped');
  const maintenance = path.join(process.env.DESTRUCTION_STATE_DIR || './storage/destruction-state', 'maintenance.json');
  const marker = JSON.stringify({ operation: 'export-readable', sessionId: randomUUID() });
  let ownsMaintenance = false;
  const db = new DataSource({ ...database(), synchronize: false, logging: false, migrationsRun: false });
  try {
    if (apply) {
      fs.mkdirSync(path.dirname(maintenance), { recursive: true });
      try { fs.writeFileSync(maintenance, marker, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw Error('Maintenance is already active. Finish the existing maintenance operation before exporting; do not delete its flag.');
        throw error;
      }
      ownsMaintenance = true;
    }
    await db.initialize();
    const rows = await db.getRepository(Document).createQueryBuilder('doc')
      .leftJoinAndSelect('doc.file', 'file')
      .where('doc.status IN (:...statuses)', { statuses: ['stored', 'approved'] })
      .andWhere('doc.destructionRequestId IS NULL')
      .andWhere('doc.destructionStartedAt IS NULL')
      .getMany();
    let created = 0;
    for (const doc of rows) if (apply && await writeReadableDocument(doc)) created++;
    console.log(JSON.stringify({ applied: apply, eligible: rows.length, created, directory: readableRoot() }));
  } finally {
    try { if (db.isInitialized) await db.destroy(); }
    finally {
      // Never remove another operation's maintenance marker.
      if (ownsMaintenance && fs.existsSync(maintenance) && fs.readFileSync(maintenance, 'utf8') === marker)
        fs.unlinkSync(maintenance);
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
