// Widen existing descriptions without reading or changing document contents.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'pdf_archive',
    connectTimeout: 10000,
  });
  try {
    const [columns] = await connection.query("SHOW FULL COLUMNS FROM documents WHERE Field = 'description'");
    const column = columns[0];
    if (!column) throw new Error('documents.description is missing.');
    if (/^(mediumtext|longtext)$/i.test(column.Type)) {
      console.log(`documents.description already uses ${column.Type}; no change needed.`);
      return;
    }
    if (column.Type.toLowerCase() !== 'text' || column.Null !== 'YES' || column.Default !== null
      || column.Extra || !/^[a-zA-Z0-9_]+$/.test(column.Collation)) {
      throw new Error('Unexpected description definition; inspect the schema before migrating.');
    }
    const sql = `ALTER TABLE documents MODIFY COLUMN description MEDIUMTEXT COLLATE ${column.Collation} NULL`;
    if (!process.argv.includes('--apply')) {
      console.log(`Preview: ${sql}`);
      console.log('Run with --apply to widen the column and preserve existing descriptions.');
      return;
    }
    await connection.query(sql);
    console.log('documents.description widened to MEDIUMTEXT; existing descriptions preserved.');
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
});
