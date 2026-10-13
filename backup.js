/**
 * backup.js
 * Script backup tự động cho hệ thống lưu trữ PDF (LTHS-BACKEND).
 * Chạy độc lập với app NestJS chính — không cần app đang sống để backup chạy.
 *
 * Việc script này làm mỗi lần chạy:
 *   1. Dump toàn bộ database MySQL ra file .sql.gz
 *   2. Đồng bộ (rclone sync) thư mục storage/archive + các bản dump DB
 *      tới TẤT CẢ đích được khai báo trong RCLONE_REMOTES (local/NAS/cloud)
 *   3. Dọn các bản dump cục bộ cũ hơn RETENTION_DAYS để đỡ đầy ổ đĩa staging
 *
 * Yêu cầu cài trước trên server:
 *   - Node.js (đã có, vì chạy chung máy với app NestJS)
 *   - mysqldump (đi kèm MySQL/MariaDB client — thường có sẵn nếu đã cài MySQL)
 *   - rclone (tải tại https://rclone.org/downloads/, chạy 1 lần `rclone config`
 *     để khai báo các remote — xem RCLONE-SETUP.md đi kèm)
 *
 * Cách chạy thử thủ công:
 *   node backup.js
 *
 * Cách lên lịch tự động: xem phần cuối file RCLONE-SETUP.md
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Cấu hình (đọc từ .env, có giá trị mặc định an toàn) ───────────────
const DB_HOST     = process.env.DB_HOST     || 'localhost';
const DB_PORT     = process.env.DB_PORT     || '3306';
const DB_NAME     = process.env.DB_NAME     || process.env.DB_DATABASE;
const DB_USER     = process.env.DB_USER     || process.env.DB_USERNAME;
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.DB_PASSWORD;

const ARCHIVE_DIR     = path.resolve(process.env.UPLOAD_ARCHIVE_DIR  || './storage/archive');
const STAGING_DIR     = path.resolve(process.env.BACKUP_STAGING_DIR  || './backup-staging');
const RETENTION_DAYS  = parseInt(process.env.BACKUP_RETENTION_DAYS   || '30', 10);

// Danh sách đích backup, phân cách bằng dấu phẩy trong .env, ví dụ:
// RCLONE_REMOTES=local-drive:D:/Backups/LTHS,nas:LTHS-Backup,gdrive:LTHS-Backup
const RCLONE_REMOTES = (process.env.RCLONE_REMOTES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');

function run(cmd) {
  console.log(`\n> ${cmd.replace(/-p\S+/, '-p****')}`); // che mật khẩu khi in log
  execSync(cmd, { stdio: 'inherit', shell: true });
}

function assertConfig() {
  const missing = [];
  if (!DB_NAME)     missing.push('DB_NAME hoặc DB_DATABASE');
  if (!DB_USER)     missing.push('DB_USER hoặc DB_USERNAME');
  if (!DB_PASSWORD) missing.push('DB_PASSWORD');
  if (missing.length) {
    throw new Error(`Thiếu biến môi trường: ${missing.join(', ')} (kiểm tra file .env)`);
  }
  if (!fs.existsSync(ARCHIVE_DIR)) {
    throw new Error(`Không tìm thấy thư mục lưu trữ file: ${ARCHIVE_DIR}`);
  }
  if (RCLONE_REMOTES.length === 0) {
    console.warn('⚠️  Chưa khai báo RCLONE_REMOTES trong .env — sẽ chỉ dump DB, KHÔNG đồng bộ đi đâu cả.');
  }
}

function dumpDatabase() {
  if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });

  const isWindows = process.platform === 'win32';
  const dumpFile  = path.join(STAGING_DIR, `db-${DB_NAME}-${TIMESTAMP}.sql${isWindows ? '' : '.gz'}`);

  console.log('📦 Đang dump database...');

  if (isWindows) {
    // Windows không có lệnh gzip mặc định — dump thô không nén
    run(`mysqldump -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p${DB_PASSWORD} --single-transaction ${DB_NAME} > "${dumpFile}"`);
    console.log('ℹ️  Windows: dump không nén (cài 7-Zip và sửa script nếu muốn nén .gz).');
  } else {
    run(`mysqldump -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p${DB_PASSWORD} --single-transaction ${DB_NAME} | gzip > "${dumpFile}"`);
  }

  console.log(`✅ Dump xong: ${dumpFile}`);
  return dumpFile;
}

function syncToRemotes() {
  for (const remote of RCLONE_REMOTES) {
    console.log(`\n☁️  Đang đồng bộ tới: ${remote}`);

    // sync = làm remote giống hệt local (xoá ở remote nếu đã xoá ở local)
    // dùng sync cho file kho lưu trữ vì đây là nguồn "sự thật" duy nhất
    run(`rclone sync "${ARCHIVE_DIR}" "${remote}/files" --create-empty-src-dirs --log-level INFO`);

    // dùng copy cho các bản dump DB vì ta muốn GIỮ LẠI lịch sử dump cũ ở remote
    // dù local đã dọn dẹp (retention) — copy không xoá gì ở đích
    run(`rclone copy "${STAGING_DIR}" "${remote}/db-dumps" --log-level INFO`);
  }
}

function cleanupOldDumps() {
  if (!fs.existsSync(STAGING_DIR)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(STAGING_DIR);
  for (const file of files) {
    const filePath = path.join(STAGING_DIR, file);
    if (fs.statSync(filePath).mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      console.log(`🗑️  Đã xoá bản dump cục bộ cũ: ${file}`);
    }
  }
}

async function main() {
  console.log(`\n=== BẮT ĐẦU BACKUP: ${TIMESTAMP} ===`);
  assertConfig();
  dumpDatabase();
  if (RCLONE_REMOTES.length > 0) syncToRemotes();
  cleanupOldDumps();
  console.log(`\n✅ Backup hoàn tất: ${TIMESTAMP}`);
}

main().catch((err) => {
  console.error(`\n❌ Backup THẤT BẠI: ${err.message}`);
  process.exit(1); // để Task Scheduler / cron ghi nhận job lỗi
});
