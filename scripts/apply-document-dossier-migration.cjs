const mysql = require('mysql2/promise');
require('dotenv').config();
async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root', password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'pdf_archive',
  });
  try {
    const [columns] = await db.query('SHOW FULL COLUMNS FROM documents');
    const exists = columns.find(column => column.Field === 'dossier_root_id');
    const [constraints] = await db.query("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='documents' AND COLUMN_NAME='dossier_root_id' AND REFERENCED_TABLE_NAME='documents' AND REFERENCED_COLUMN_NAME='id'");
    if (exists && constraints.length) { console.log('Document dossier schema already exists.'); return; }
    const statements = [];
    if (!exists) {
      const id = columns.find(column => column.Field === 'id');
      if (!id || !/^varchar\(36\)$/i.test(id.Type) || !/^[a-z0-9_]+$/i.test(id.Collation))
        throw new Error('Unexpected documents.id definition; review schema before migrating.');
      const charset = id.Collation.split('_')[0];
      statements.push(`ALTER TABLE documents ADD COLUMN dossier_root_id varchar(36) CHARACTER SET ${charset} COLLATE ${id.Collation} NULL`);
    }
    if (!constraints.length) statements.push('ALTER TABLE documents ADD CONSTRAINT fk_documents_dossier_root FOREIGN KEY (dossier_root_id) REFERENCES documents(id) ON DELETE RESTRICT');
    if (!process.argv.includes('--apply')) {
      console.log('Dry run. Execute with --apply to add the nullable dossier link and foreign key.');
      statements.forEach(statement => console.log(statement));
      return;
    }
    for (const statement of statements) await db.query(statement);
    console.log('Document dossier migration applied. Existing files and approval states are unchanged.');
  } finally { await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
