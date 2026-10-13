/**
 * Chạy: node create-admin.js
 * Script này in ra câu SQL để insert admin vào database.
 */
const bcrypt = require('bcrypt');

async function main() {
  const password = 'admin123';
  const hash = await bcrypt.hash(password, 10);

  console.log('\n=== Chạy câu SQL này trong phpMyAdmin (database ltgt) ===\n');
  console.log(`INSERT INTO users (id, full_name, email, password_hash, role, is_active, must_change_password, created_at)
VALUES (
  UUID(),
  'Admin',
  'admin@gmail.com',
  '${hash}',
  'admin',
  1,
  1,
  NOW()
);\n`);
  console.log('=== Sau đó đăng nhập với: admin@gmail.com / admin123 ===\n');
}

main();
