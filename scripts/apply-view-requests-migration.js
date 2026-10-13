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

  const migrationPath = path.join(__dirname, 'migrate-view-requests.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  for (const statement of splitSqlStatements(sql)) {
    try {
      await connection.query(statement);
    } catch (error) {
      const duplicateSchemaChange =
        error.code === 'ER_DUP_FIELDNAME' ||
        error.code === 'ER_DUP_KEYNAME' ||
        error.code === 'ER_FK_DUP_NAME' ||
        /Duplicate column|Duplicate key name|Duplicate foreign key constraint name|errno: 121/i.test(error.message);

      if (!duplicateSchemaChange) {
        throw error;
      }
    }
  }

  const [viewRequests] = await connection.query("SHOW TABLES LIKE 'view_requests'");
  const [accessLogs] = await connection.query("SHOW TABLES LIKE 'access_logs'");
  const [notificationType] = await connection.query("SHOW COLUMNS FROM notifications LIKE 'type'");

  console.log(JSON.stringify({
    view_requests: viewRequests.length,
    access_logs: accessLogs.length,
    notification_type: notificationType[0]?.Type || null,
  }, null, 2));

  await connection.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
