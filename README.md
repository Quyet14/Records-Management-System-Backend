# document-archive-system

Bảo vệ kho, khóa ngoài dự án, migration và chuyển đổi file cũ: [hướng dẫn triển khai bảo mật](docs/security-hardening.md). Đọc trước khi khởi động bản mới; production yêu cầu HTTPS và cấu hình khóa mã hóa.

Quy trình hủy hồ sơ backend: [hướng dẫn API, migration, gateway và nghiệm thu](docs/destruction-workflow.md).
Chạy trực tiếp trên server Windows, không cần gateway API riêng: [cấu hình local, kiểm tra và bật dịch vụ](docs/destruction-local.md).

```powershell
npm run test:destruction
npm run test:destruction-local
node scripts/test-document-security.cjs
node scripts/test-document-review-permissions.cjs
```

Giữ `DESTRUCTION_ENABLED=false` cho tới khi `npm run destruction:check` đạt và đã nghiệm thu staging. Chế độ local dùng SMTP, filesystem và ClamAV hoặc Microsoft Defender (`DESTRUCTION_SCANNER=defender` trên Windows) ngay trong backend; gateway là tùy chọn cho hạ tầng có adapter riêng. Migration không tự chạy lúc khởi động; chỉ vận hành chạy `npm run db:add-destruction` sau khi sao lưu và kiểm tra cấu hình DB.
