const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'pdf_archive',
    multipleStatements: false,
  });

  const migrationPath = path.join(__dirname, 'add-user-permissions.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  for (const statement of splitSqlStatements(sql)) {
    await connection.query(statement);
  }

  const [permissions] = await connection.query(
    "SHOW COLUMNS FROM users LIKE 'permissions'",
  );

  console.log(JSON.stringify({
    users_permissions: permissions[0]?.Type || null,
  }, null, 2));

  await connection.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
