require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE,
  });

  // Xem trước 3 record
  const [before] = await conn.execute(
    'SELECT full_name, position, qualification FROM users WHERE cccd IS NOT NULL LIMIT 3'
  );
  console.log('BEFORE:');
  before.forEach(r => console.log(' ', r.full_name, '| position:', r.position, '| qual:', r.qualification));

  // Vấn đề: seed cũ lưu chức vụ vào position ĐÚNG
  // nhưng qualification vẫn null vì insert cũ không có qualification column
  // Script fix-qualification đã chạy đúng trước đó (895 records có qual)
  // Kiểm tra lại thực tế

  const [[stats]] = await conn.execute(
    'SELECT COUNT(*) total, SUM(qualification IS NOT NULL) has_qual, SUM(position IS NOT NULL) has_pos FROM users'
  );
  console.log('\nStats:', stats);

  // Nếu qualification = null nhưng position có giá trị trình độ (không phải chức vụ)
  // Các chức vụ thực sự: Trưởng khoa, Phó Trưởng khoa, Bác sĩ, Điều dưỡng Trưởng, etc.
  // Trình độ: BSCK I, BSCK II, Thạc sĩ, Tiến sĩ, Cao đẳng, etc.
  // Với data hiện tại qualification đã được update đúng rồi - chỉ cần verify

  const [sample] = await conn.execute(
    `SELECT full_name, position, qualification, cccd FROM users 
     WHERE cccd IS NOT NULL 
     ORDER BY RAND() LIMIT 5`
  );
  console.log('\nRandom sample:');
  sample.forEach(r => console.log(' ', r.full_name, '\n   pos:', r.position, '\n   qual:', r.qualification));

  await conn.end();
}

main().catch(e => {
  console.error('ERR:', e.message);
  console.error('Code:', e.code);
  console.error('Stack:', e.stack);
});
