/**
 * Reset password for an existing user.
 *
 * Usage:
 *   node reset-password.js admin@gmail.com admin123
 *   node reset-password.js van12@gmail.com Van12345@
 */

require('dotenv').config();

const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');

async function main() {
  const [, , email, password] = process.argv;

  if (!email || !password) {
    console.error('Usage: node reset-password.js <email> <new-password>');
    process.exit(1);
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'pdf_archive',
  });

  const [users] = await connection.execute(
    'SELECT id, email, is_active FROM users WHERE email = ? LIMIT 1',
    [email],
  );

  if (users.length === 0) {
    await connection.end();
    throw new Error(`Khong tim thay user: ${email}`);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await connection.execute(
    'UPDATE users SET password_hash = ?, is_active = 1 WHERE email = ?',
    [passwordHash, email],
  );

  await connection.end();
  console.log(`Da reset mat khau va kich hoat tai khoan: ${email}`);
}

main().catch((err) => {
  console.error(`Reset password failed: ${err.message}`);
  process.exit(1);
});
