/**
 * seed-staff.js
 * Import danh sách 896 nhân viên Bệnh viện Hữu Nghị vào hệ thống.
 * - Tạo departments nếu chưa có
 * - Tạo tài khoản user cho từng nhân viên
 * - Password mặc định: Nhanvien@123 (nên đổi sau khi import)
 * - Email: <ho_ten_khong_dau>@bvhn.vn (tự sinh, unique)
 *
 * Chạy kiểm tra: node seed-staff.js --check
 * Import vào DB (PowerShell): $env:STAFF_EXCEL_PATH='./danh-sach-896.xlsx'; node seed-staff.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const DEFAULT_PASSWORD = 'Nhanvien@123';
const EXPECTED_STAFF_COUNT = 896;
const STAFF_EXCEL_PATH = process.env.STAFF_EXCEL_PATH || path.resolve('./staff.xlsx');

async function loadStaffFromExcel(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Không tìm thấy file Excel: ${filePath}. Đặt đường dẫn bằng STAFF_EXCEL_PATH.`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('File Excel không có worksheet.');

  const normalizeHeader = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
  const aliases = {
    stt: ['stt', 'so thu tu', 'no'],
    dept: ['khoa phong', 'khoa', 'phong', 'don vi', 'bo phan'],
    name: ['ho va ten', 'ho ten', 'ten nhan vien', 'name'],
    chucvu: ['chuc vu', 'chuc danh', 'vi tri'],
    role: ['role', 'vai tro', 'quyen'],
  };
  const headerRow = worksheet.getRow(1);
  const columns = {};
  headerRow.eachCell((cell, columnNumber) => {
    const header = normalizeHeader(cell.value);
    for (const [field, names] of Object.entries(aliases)) {
      if (!columns[field] && names.includes(header)) columns[field] = columnNumber;
    }
  });
  if (!columns.name || !columns.dept) {
    throw new Error('Excel phải có cột Họ và tên và Khoa/Phòng.');
  }

  const staff = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const value = (field) => columns[field] ? String(row.getCell(columns[field]).value || '').trim() : '';
    const name = value('name');
    const dept = value('dept');
    if (!name && !dept) return;
    if (!name || !dept) throw new Error(`Dòng ${rowNumber} thiếu họ tên hoặc khoa/phòng.`);
    const chucvu = value('chucvu');
    const explicitRole = value('role').toLowerCase();
    const role = ['admin', 'department_head', 'user'].includes(explicitRole)
      ? explicitRole
      : /giám đốc/.test(chucvu.toLowerCase()) ? 'admin'
        : /trưởng khoa|trưởng phòng/.test(chucvu.toLowerCase()) ? 'department_head' : 'user';
    staff.push({ stt: Number(value('stt')) || staff.length + 1, dept, name, role, chucvu });
  });

  if (staff.length !== EXPECTED_STAFF_COUNT) {
    throw new Error(`Excel có ${staff.length} nhân viên hợp lệ, cần đúng ${EXPECTED_STAFF_COUNT}.`);
  }
  return staff;
}

// ─── Helper: chuyển tên có dấu thành không dấu ───────────────
function removeDiacritics(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/\s+/g, '.')
    .toLowerCase();
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const staff = await loadStaffFromExcel(STAFF_EXCEL_PATH);
  const departments = [...new Set(staff.map((person) => person.dept))];
  console.log(`Đã đọc ${staff.length}/${EXPECTED_STAFF_COUNT} nhân viên từ ${STAFF_EXCEL_PATH}`);
  if (process.argv.includes('--check')) {
    console.log(`Khoa/Phòng trong Excel: ${departments.length}`);
    return;
  }

  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE,
  });

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  console.log(`\n=== SEED NHÂN VIÊN BỆNH VIỆN HỮU NGHỊ ===`);
  console.log(`Password mặc định: ${DEFAULT_PASSWORD}\n`);

  // 1. Tạo departments
  console.log('1. Tạo khoa/phòng...');
  const deptMap = new Map(); // name → id

  // Load existing departments
  const [existingDepts] = await conn.execute('SELECT id, name FROM departments');
  for (const d of existingDepts) deptMap.set(d.name, d.id);

  for (const deptName of departments) {
    if (!deptMap.has(deptName)) {
      const id = crypto.randomUUID();
      await conn.execute(
        'INSERT INTO departments (id, name) VALUES (?, ?)',
        [id, deptName]
      );
      deptMap.set(deptName, id);
      console.log(`   ✅ Tạo mới: ${deptName}`);
    } else {
      console.log(`   ⏭️  Đã có: ${deptName}`);
    }
  }

  // 2. Tạo users
  console.log('\n2. Tạo tài khoản nhân viên...');
  let created = 0, skipped = 0, errors = 0;
  const usedEmails = new Set();

  // Load existing emails
  const [existingUsers] = await conn.execute('SELECT email FROM users');
  for (const u of existingUsers) usedEmails.add(u.email);

  for (const person of staff) {
    const deptId = deptMap.get(person.dept);
    if (!deptId) {
      console.log(`   ⚠️  Không tìm thấy khoa: ${person.dept}`);
      errors++;
      continue;
    }

    // Tạo email unique từ tên
    let baseEmail = removeDiacritics(person.name) + '@bvhn.vn';
    let email = baseEmail;
    let suffix = 1;
    while (usedEmails.has(email)) {
      email = baseEmail.replace('@', `${suffix}@`);
      suffix++;
    }

    // Kiểm tra email đã có trong DB chưa
    const [[existing]] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      console.log(`   ⏭️  Đã có: ${person.name} (${email})`);
      skipped++;
      usedEmails.add(email);
      continue;
    }

    usedEmails.add(email);

    try {
      const id = crypto.randomUUID();
      await conn.execute(
        `INSERT INTO users (id, full_name, email, password_hash, role, department_id, is_active, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
        [id, person.name, email, passwordHash, person.role, deptId]
      );
      console.log(`   ✅ [${person.stt.toString().padStart(3)}] ${person.name} → ${email} (${person.role})`);
      created++;
    } catch (err) {
      console.log(`   ❌ Lỗi tạo ${person.name}: ${err.message}`);
      errors++;
    }
  }

  await conn.end();

  console.log(`\n=== KẾT QUẢ ===`);
  console.log(`Khoa/Phòng: ${deptMap.size} (${departments.length} từ Excel)`);
  console.log(`Nhân viên tạo mới: ${created}`);
  console.log(`Bỏ qua (đã tồn tại): ${skipped}`);
  console.log(`Lỗi: ${errors}`);
  console.log(`\nPassword mặc định cho tất cả: ${DEFAULT_PASSWORD}`);
  console.log('Vui lòng thông báo nhân viên đổi password sau khi đăng nhập lần đầu.\n');
}

main().catch((err) => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
