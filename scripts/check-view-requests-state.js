const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'pdf_archive',
  });

  const [viewRequests] = await connection.query(
    'SELECT id, document_id, requester_id, status, created_at FROM view_requests ORDER BY created_at DESC LIMIT 5',
  );
  const [accessLogs] = await connection.query(
    'SELECT id, document_id, user_id, action, timestamp FROM access_logs ORDER BY timestamp DESC LIMIT 5',
  );

  console.log(JSON.stringify({ viewRequests, accessLogs }, null, 2));
  await connection.end();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
