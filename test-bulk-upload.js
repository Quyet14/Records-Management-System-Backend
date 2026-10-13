/**
 * test-bulk-upload.js
 * Script test đẩy loạt dữ liệu: upload nhiều PDF giả → duyệt tất cả → kiểm tra cấu trúc folder.
 *
 * Chạy: node test-bulk-upload.js
 * Yêu cầu: backend đang chạy tại http://localhost:3000
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const http = require('http');

const BASE_URL     = `http://localhost:${process.env.PORT || 3000}`;
const ARCHIVE_DIR  = path.resolve(process.env.UPLOAD_ARCHIVE_DIR || './storage/archive');

// ─── Cấu hình tài khoản test ────────────────────────────────
// Sửa lại email/password cho đúng với DB của bạn
const ADMIN_EMAIL    = 'admin@gmail.com';
const ADMIN_PASSWORD = 'admin123';
const USER_EMAIL     = 'van12@gmail.com';
const USER_PASSWORD  = 'Van12345@';

// ─── Danh sách file test ────────────────────────────────────
const TEST_FILES = [
  { title: 'Hồ sơ bệnh án - BN001', dept: null },
  { title: 'Báo cáo tháng 8/2026',  dept: null },
  { title: 'Giấy khám sức khỏe - NV001', dept: null },
  { title: 'Phiếu điều trị - P001', dept: null },
  { title: 'Hồ sơ phẫu thuật - BN002', dept: null },
];

// ─── Helper: tạo PDF giả hợp lệ (PDF tối thiểu ~100 bytes) ──
function makeFakePdf(title) {
  // PDF header tối thiểu để server không reject
  const content = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
190
%%EOF`;
  return Buffer.from(content);
}

// ─── Helper: HTTP request đơn giản ──────────────────────────
function request(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlPath, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port:     url.port || 3000,
      path:     url.pathname + url.search,
      method,
      headers,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Helper: multipart/form-data upload ─────────────────────
function uploadFile(token, title, pdfBuffer, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now();
    const CRLF = '\r\n';

    const parts = [];
    // field: title
    parts.push(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="title"${CRLF}${CRLF}` +
      title,
    );
    // field: file
    parts.push(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
      `Content-Type: application/pdf${CRLF}${CRLF}`,
    );

    const header  = Buffer.from(parts.join(CRLF) + CRLF);
    const footer  = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const bodyBuf = Buffer.concat([header, pdfBuffer, footer]);

    const opts = {
      hostname: 'localhost',
      port:     process.env.PORT || 3000,
      path:     '/documents/upload',
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
      },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ─── Helper: in cấu trúc folder ─────────────────────────────
function printFolderTree(dir, indent = '') {
  if (!fs.existsSync(dir)) {
    console.log(`  (thư mục không tồn tại: ${dir})`);
    return;
  }
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      console.log(`${indent}📁 ${item}/`);
      printFolderTree(full, indent + '  ');
    } else {
      const kb = (stat.size / 1024).toFixed(1);
      console.log(`${indent}📄 ${item} (${kb} KB)`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('=== TEST BULK UPLOAD + APPROVE ===\n');

  // 1. Login admin
  console.log('1. Đăng nhập admin...');
  const adminLogin = await request('POST', '/auth/login',
    { 'Content-Type': 'application/json' },
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  );
  if (!adminLogin.body?.access_token) {
    console.error('❌ Login admin thất bại:', JSON.stringify(adminLogin.body));
    console.log('   → Sửa ADMIN_EMAIL và ADMIN_PASSWORD trong script này cho đúng với DB.');
    process.exit(1);
  }
  const adminToken = adminLogin.body.access_token;
  console.log(`   ✅ Admin: ${adminLogin.body.user?.email} (${adminLogin.body.user?.role})\n`);

  // 2. Login user
  console.log('2. Đăng nhập user...');
  const userLogin = await request('POST', '/auth/login',
    { 'Content-Type': 'application/json' },
    JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
  );
  if (!userLogin.body?.access_token) {
    console.error('❌ Login user thất bại:', JSON.stringify(userLogin.body));
    console.log('   → Sửa USER_EMAIL và USER_PASSWORD trong script này cho đúng với DB.');
    process.exit(1);
  }
  const userToken  = userLogin.body.access_token;
  console.log(`   ✅ User: ${userLogin.body.user?.email} (${userLogin.body.user?.role})\n`);

  // 3. Upload từng file
  console.log('3. Upload file...');
  const uploadedIds = [];
  for (const f of TEST_FILES) {
    const pdf      = makeFakePdf(f.title);
    const filename = `${f.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const res      = await uploadFile(userToken, f.title, pdf, filename);
    if (res.status === 201 && res.body?.id) {
      uploadedIds.push(res.body.id);
      console.log(`   ✅ Uploaded: "${f.title}" → id=${res.body.id}`);
    } else {
      console.log(`   ⚠️  Upload thất bại: "${f.title}" → ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
  console.log(`\n   Tổng: ${uploadedIds.length}/${TEST_FILES.length} file upload thành công.\n`);

  if (uploadedIds.length === 0) {
    console.error('❌ Không có file nào upload được, dừng test.');
    process.exit(1);
  }

  // 4. Duyệt từng file bằng admin
  console.log('4. Duyệt file (admin approve)...');
  const approvedIds = [];
  for (const id of uploadedIds) {
    const res = await request('PATCH', `/documents/${id}/approve`,
      { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    );
    if (res.status === 200) {
      approvedIds.push(id);
      console.log(`   ✅ Approved: ${id}`);
    } else {
      console.log(`   ⚠️  Approve thất bại: ${id} → ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
  console.log(`\n   Tổng: ${approvedIds.length}/${uploadedIds.length} file được duyệt.\n`);

  // 5. In cấu trúc folder archive
  console.log('5. Cấu trúc folder archive sau khi duyệt:');
  console.log(`   ${ARCHIVE_DIR}`);
  printFolderTree(ARCHIVE_DIR, '   ');

  // 6. Kiểm tra file .log
  console.log('\n6. Nội dung file log (nếu có):');
  const today   = new Date();
  const yyyy    = today.getFullYear();
  const mm      = String(today.getMonth() + 1).padStart(2, '0');
  const dd      = String(today.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const logFile = path.join(ARCHIVE_DIR, String(yyyy), dateStr, `${dateStr}.log`);
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    console.log(`   File: ${logFile}`);
    console.log(`   Số dòng: ${lines.length}`);
    console.log('   Cột: timestamp | action | uploader | approver | docId | fileName | size(bytes)');
    console.log('   ---');
    lines.forEach((l) => console.log(`   ${l}`));
  } else {
    console.log(`   ⚠️  Không tìm thấy log: ${logFile}`);
  }

  console.log('\n=== HOÀN TẤT ===');
}

main().catch((err) => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
