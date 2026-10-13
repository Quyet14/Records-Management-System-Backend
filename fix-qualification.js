/**
 * fix-qualification.js
 * Sửa lại data: position đang chứa trình độ, qualification rỗng.
 * Cần đọc từ seed script để biết đúng position và qualification của từng người (theo CCCD).
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

// Đọc STAFF từ seed-staff-full.js
// Format: [dept, name, dob, gender, position(chức vụ), qualification(trình độ), cccd, role]
const fs = require('fs');
const script = fs.readFileSync('./seed-staff-full.js', 'utf8');

// Extract STAFF array
const startIdx = script.indexOf('const STAFF = [') + 'const STAFF = ['.length;
const endIdx = script.indexOf('];\n\nasync function main');
const staffContent = script.substring(startIdx, endIdx);

let STAFF;
try {
  eval('STAFF = [' + staffContent + ']');
} catch(e) {
  console.error('Parse error:', e.message);
  process.exit(1);
}

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE,
  });

  console.log(`Parsed ${STAFF.length} staff records`);

  // Kiểm tra trước
  const [[sample]] = await conn.execute(
    'SELECT full_name, position, qualification, cccd FROM users WHERE cccd IS NOT NULL LIMIT 1'
  );
  console.log('Sample before fix:', sample);

  let updated = 0, skipped = 0;

  for (const [dept, name, dob, gender, chucvu, trinhdo, cccd, role] of STAFF) {
    if (!cccd) { skipped++; continue; }

    const [r] = await conn.execute(
      'UPDATE users SET position=?, qualification=? WHERE cccd=?',
      [chucvu || null, trinhdo || null, cccd]
    );
    if (r.affectedRows > 0) updated++;
    else skipped++;
  }

  // Kiểm tra sau
  const [[sample2]] = await conn.execute(
    'SELECT full_name, position, qualification, cccd FROM users WHERE cccd=?',
    [STAFF[0][6]]
  );
  console.log('Sample after fix:', sample2);

  const [[{with_qual}]] = await conn.execute(
    'SELECT SUM(qualification IS NOT NULL) as with_qual FROM users'
  );

  console.log(`\n✅ Updated: ${updated}, Skipped: ${skipped}`);
  console.log(`Users with qualification: ${with_qual}`);

  await conn.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
