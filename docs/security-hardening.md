# Bảo vệ kho hồ sơ và triển khai

Thay đổi này triển khai bốn nhóm ưu tiên ở backend: mã hóa/cấp file, audit chỉ thêm, giới hạn request/OTP và kiểm tra toàn vẹn định kỳ. Cấu hình trên máy chủ, frontend và nghiệm thu thực tế là các bước triển khai riêng. Không bật production chỉ bằng cách sao chép file `.env.example`.

## Hành vi đã triển khai

- File hồ sơ và file cá nhân mới được kiểm tra magic bytes, parse PDF, quét ClamAV rồi mã hóa AES-256-GCM. PDF rỗng, lỗi hoặc đã mã hóa bị từ chối. Giữ hỗ trợ ZIP/RAR/7Z/TAR/GZ hiện có, kiểm tra chữ ký định dạng và quét trước khi mã hóa. Giới hạn chung theo `MAX_FILE_SIZE_MB`; PDF thêm giới hạn 100 MiB để kiểm soát RAM khi parse/watermark. `clamscan` trả lỗi, timeout hoặc thiếu cấu hình đều chặn upload.
- Tên vật lý mới là UUID, đuôi `.lths`; tên gốc chỉ là metadata. Dedup vẫn dựa trên SHA-256 nội dung gốc. Khoa upload của user/trưởng khoa được kiểm tra ở server. `autoApprove` do client gửi không cấp quyền duyệt cho user.
- Import `index-files` và SQL Server cũng quét/mã hóa vào kho riêng; phải build trước khi chạy. `FILE_IMPORT_MODE=link` bị chặn khi bật mã hóa. Bản gốc ở nguồn import vẫn do đơn vị quản lý nguồn bảo vệ/xóa theo quy trình; importer không xóa dữ liệu nguồn.
- Khóa chỉ đọc từ `ARCHIVE_KEY_FILE`, nằm ngoài project, web root, archive, staging, personal, journal và backup. Production kiểm tra các thư mục dữ liệu phải là đường dẫn tuyệt đối ngoài project/web root, kể cả đường dẫn thực qua junction. Linux/macOS yêu cầu key file 0600; Windows phải đặt ACL tại máy chủ.
- Không có static route cho kho file. Các endpoint nội dung giải mã qua backend sau khi kiểm tra quyền; đường dẫn dữ liệu chỉ được đọc trong các storage root đã cấu hình. Không ghi bản giải mã xuống disk khi xem/tải. Bản upload thô tồn tại tạm trong staging riêng; interceptor dọn staging khi kết thúc xử lý, kể cả khi DTO hoặc quyền bị từ chối. Cần quét dọn staging sau sự cố tiến trình, không đưa staging vào backup.
- `GET /documents/:id/view-url` dùng cùng guard của `/view`, trả `{url, expiresIn, expiresAt}`. Token gắn user, session, document và mục đích xem, sống tối đa 120 giây và không vượt hạn phiếu đã duyệt/hạn tuyệt đối của session. `/download-url` cũng tối đa 120 giây. Token xem không dùng được để tải hoặc gọi API khác; token tải không dùng được để xem. Link bearer có thể bị người giữ link chuyển tiếp: không đưa URL vào analytics/log; frontend nên lấy link mới khi cần. Backend kiểm tra lại session, vai trò, khoa, độ mật và quyền xem mỗi lần dùng link. Chờ gia hạn không kéo dài phiếu đã hết hạn.
- `/view` PDF luôn có watermark tên/email và thời điểm xem; lỗi watermark không trả bản gốc. Header `no-store`, `no-referrer`, `nosniff`; chỉ frontend origin được cấu hình mới được nhúng PDF. Quyền xem trực tiếp hiện có của chủ hồ sơ/admin/trưởng khoa/người có quyền xem khoa vẫn áp dụng; người cần phiếu phải có phiếu còn hạn. User không được lấy file nén qua đường `/view` để vượt chặn tải.
- User tiếp tục không có quyền tải bản gốc. Watermark và ẩn nút in/tải không phải DRM: trình duyệt đã hiển thị nội dung vẫn có thể lưu bản xem/chụp màn hình. Chặn nút in/tải cần tích hợp viewer ở frontend; repo này chỉ có backend.
- Audit HTTP ghi user, IP đã qua chính sách proxy, route mẫu, UUID tài nguyên, thời gian, kết quả/status, request ID; không ghi token, cookie, body hoặc query string. Subscriber bổ sung IP/request ID cho audit nghiệp vụ upload/duyệt/hủy/đổi quyền. Migration độc lập tạo trigger chặn UPDATE/DELETE `audit_logs`. Đây là bảo vệ trước tài khoản ứng dụng; DBA có quyền DROP/TRUNCATE/ALTER vẫn có thể can thiệp, nên cần quyền tối thiểu và bản log xuất sang kho bất biến riêng nếu cần chống DBA. Chưa triển khai hash chain.
- Helmet đặt security headers. Throttler dùng bộ đếm InnoDB chung giữa các PM2 process, theo IP đã xác định bởi Express: 300 request/phút toàn API, 20/phút nhóm `/auth/`, 60/phút nhóm xem/tải hồ sơ. Trả 429 và cảnh báo trong log khi vượt. Lỗi DB không cho request vượt limiter. Cần điều chỉnh/nghiệm thu mức giới hạn theo số người dùng chung NAT/proxy.
- OTP đăng nhập và reset: 5 phút, tối đa 5 lần nhập, gửi lại sau 60 giây, tối đa 10 lần/giờ/tài khoản/mục đích. Mã mới vô hiệu mã cũ; đếm sai và consume OTP khóa dòng trong transaction để chống gọi song song. Mã được lưu bằng HMAC gắn user/mục đích. OTP/reset token cấp trước lần nâng cấp này cần cấp lại.
- Sau 5 lần xác thực sai bằng OTP hoặc mật khẩu, tài khoản bị khóa 15 phút; gửi mã mới không bỏ qua khóa. Bcrypt 6 tiếp tục dùng hash bcrypt; login hiện tại vẫn là email/CAPTCHA + OTP bắt buộc, không đổi sang luồng mật khẩu.
- Access token hiện tại 20 phút, refresh token xoay vòng trong cookie HttpOnly/Secure/SameSite, hết hạn tuyệt đối 30 ngày. Production từ chối cookie không Secure. Session hết hạn sau `AUTH_IDLE_MINUTES` (mặc định 30), file token không gia hạn hoạt động của session. Refresh token bị dùng lại sẽ thu hồi session. `GET /auth/sessions` xem thiết bị của mình; `DELETE /auth/sessions/:id` đăng xuất một thiết bị; `/auth/logout-all` đăng xuất tất cả. Không trả token trong danh sách thiết bị. User agent/IP chỉ là nhãn tham khảo, không chứng minh danh tính thiết bị.
- Đổi vai trò/quyền/trạng thái tài khoản, email hoặc khoa cần session vừa xác thực OTP trong 5 phút (`RECENT_AUTH_REQUIRED` nếu quá hạn). Frontend cần cho đăng nhập lại bằng OTP rồi gửi lại thao tác. Duyệt hủy vẫn có challenge OTP riêng và giữ quy tắc đã chốt: hồ sơ thường một admin hoặc trưởng khoa; hồ sơ mật cả hai.
- Kiểm tra toàn vẹn hàng tuần Chủ Nhật 03:00 giờ Việt Nam; kiểm tra cả hồ sơ pending/approved/stored, phiên bản còn nội dung và file cá nhân. File đang hủy/đã hủy được loại theo vòng đời. Thiếu checksum cũng là lỗi, không tự cập nhật baseline. Ghi audit tổng hợp và cảnh báo khi lỗi. `GET /system/verify-checksums` cho admin kiểm tra chủ động. Với kho lớn cần lên lịch ngoài giờ và theo dõi I/O.

## Định dạng mã hóa và hủy hồ sơ

Container v1 gồm magic `LTHSAE01`, key ID, salt ngẫu nhiên 16 byte, độ dài plaintext và SHA-256 plaintext. HKDF-SHA256 tạo khóa riêng cho từng file từ master key và salt. Nội dung chia khối 1 MiB, mỗi khối AES-256-GCM có nonce theo số thứ tự và tag 16 byte. Header cùng số thứ tự là AAD. Kích thước container cố định theo header để phát hiện cắt nối; mỗi khối chỉ được xuất sau khi xác thực tag. PDF/watermark đọc toàn bộ trong giới hạn 100 MiB; download streaming kiểm tra toàn vẹn trước khi bắt đầu rồi xác thực lại từng khối khi truyền. Định dạng cần được kiểm định bảo mật độc lập trước khi dùng cho kho có yêu cầu chứng nhận.

SHA-256 của `documents/files/document_versions` vẫn là hash nội dung gốc, không đổi sang hash ciphertext. Local destruction inventory xác minh hash nội dung gốc với snapshot rồi ghi hash ciphertext vào từng object của manifest. Worker/checkpoint/tombstone/backup purge tiếp tục xác minh đúng bytes vật lý được xóa. Không chuyển đổi file đang có đề nghị hủy.

Tham khảo API xác thực GCM của [Node.js](https://nodejs.org/api/crypto.html), cấu hình [Throttler NestJS](https://docs.nestjs.com/security/rate-limiting), [Helmet NestJS](https://docs.nestjs.com/security/helmet) và tài liệu [quét ClamAV](https://docs.clamav.net/manual/Usage/Scanning.html).

## Trình tự triển khai

1. Sao lưu DB và nội dung, kiểm tra phục hồi trên môi trường riêng. Dừng API, PM2 worker, backup và import để chuyển đổi kho. Tạo `maintenance.json` trong `DESTRUCTION_STATE_DIR` (nội dung `{}` là đủ); giữ file này tới khi nghiệm thu xong. Không dùng file này để thay thế việc dừng tiến trình.
2. `npm ci` và `npm run build`. Chạy các migration auth sessions/destruction đã có nếu chưa cài; sau đó `node scripts/apply-security-migration.cjs --apply` bằng tài khoản migration. Bảng auth_sessions phải có trước security migration. Migration không tự chạy khi khởi động. Không bật `DB_SYNCHRONIZE` trong production.
3. Đặt storage/staging/personal ngoài project và web root, đổi cấu hình và di chuyển dữ liệu bằng kế hoạch riêng nếu đường dẫn hiện tại còn nằm trong web root. Lệnh chuyển đổi dưới đây chỉ đổi file trong root hiện tại, không tự di chuyển toàn bộ kho hoặc sửa các đường dẫn gốc đang cấu hình sai. Cấm mọi Apache/IIS/nginx alias tới storage, source, journal, `.env` hoặc khóa. `.htaccess` không bảo vệ khỏi IIS/nginx/live-server. Không chạy live-server/XAMPP dev trong production.
4. Tạo thư mục secrets riêng trên server. Ví dụ: `node scripts/generate-archive-key.cjs E:/LTHS-Secrets/archive-keys.json`. Script không in khóa và không ghi đè. Đặt `ARCHIVE_KEY_FILE` tương ứng; Windows đặt ACL chỉ service account và nhóm quản trị được đọc, user khác không được truy cập. Giữ bản phục hồi khóa mã hóa riêng với backup nội dung; mất khóa sẽ không giải mã được.
5. Cấu hình `ARCHIVE_ENCRYPTION_ENABLED=true`, `ARCHIVE_ALLOW_LEGACY_READ=false`, `UPLOAD_SCAN_ENABLED=true`, `UPLOAD_CLAMAV_PATH` tuyệt đối. Cài ClamAV/freshclam, cập nhật chữ ký, đặt giới hạn scan/archive recursion phù hợp và xử lý mọi cảnh báo vượt giới hạn; kiểm tra với file sạch và EICAR trên staging. Scanner phải quét được toàn bộ dung lượng được phép upload; không coi file bị bỏ qua do vượt giới hạn là sạch.
6. Xem kế hoạch: `node scripts/encrypt-legacy-archive.cjs`. Lệnh mặc định chỉ đọc và xác minh checksum. Nếu thiếu baseline, đối chiếu nguồn/bản sao tin cậy rồi mới thêm `--baseline-missing-checksums`; không dùng cờ này để hợp thức hóa file đã bị sửa. Checksum không khớp phải điều tra trước.
7. Khi đã xác nhận mọi tiến trình dừng: `node scripts/encrypt-legacy-archive.cjs --apply --processes-stopped`. Tạo container mới, xác minh, cập nhật mọi tham chiếu DB trong transaction, ghi audit; giữ plaintext cũ để phục hồi. Với kế hoạch đã nghiệm thu, thêm `--remove-plaintext` ngay lần chuyển đổi để xóa nguồn sau commit. Lần chạy lại không tự tìm/xóa file mồ côi từ lần trước. Nếu dừng sau commit trước khi xóa, phải kiểm kê và dọn plaintext còn sót riêng. Các snapshot/backup plaintext trước đó cũng cần kế hoạch hết hạn/chuyển đổi riêng.
8. Production: `NODE_ENV=production`, `AUTH_COOKIE_SECURE=true`, frontend/CORS dùng HTTPS, `WEB_ROOT` khai báo đúng. Đặt `JWT_SECRET` ngẫu nhiên độc lập dài tối thiểu 32 ký tự, không dùng chuỗi mẫu; tách `.env` production khỏi source/backup công khai. Cấu hình TLS 1.2+ tại reverse proxy, HSTS và redirect HTTP, chỉ mở port HTTPS ra người dùng; Nest/DB chỉ được truy cập từ mạng dịch vụ. `TRUST_PROXY_CIDRS` chỉ gồm proxy thực, không đặt trust mọi địa chỉ. Không log `$request_uri`/query token tại proxy; chỉ log path đã loại query hoặc tắt access log endpoint file.
9. Chạy kiểm thử phía dưới, nghiệm thu ClamAV thật, MySQL triggers/locks, truy cập chéo user/khoa, phiếu hết hạn, logout thu hồi link, watermark/PDF nhúng đúng frontend origin. Gỡ maintenance flag và khởi động ứng dụng sau khi nghiệm thu.

Đổi khóa: thêm key ID và khóa ngẫu nhiên mới vào cùng keyring rồi đổi `current` theo thao tác thay file nguyên tử. Giữ các khóa cũ để đọc file/backup cũ. Không ghi đè giá trị của key ID cũ. Công cụ chuyển đổi hiện xử lý plaintext, chưa có thao tác mã hóa lại container đang dùng khóa cũ.

## Quyền DB, backup, frontend và giới hạn còn lại

Tài khoản runtime cần SELECT/INSERT trên audit_logs, không có UPDATE/DELETE audit, không có ALTER/DROP/TRIGGER/TRUNCATE/FILE và không có quyền quản trị DB. Tài khoản migration tách riêng, DB không mở public. Trigger UPDATE/DELETE không chặn TRUNCATE của DBA. Bảo vệ và sao lưu audit sang kho riêng nếu cần bằng chứng ngoài DB.

Nội dung mới ở archive/personal đã mã hóa nên bản sao của container cũng mã hóa. DB dump, PDF chứng từ hủy đang lưu trong DB, nhật ký nghiệp vụ, staging và các backup cũ vẫn có thể chứa dữ liệu nhạy cảm: cần mã hóa toàn bộ bộ backup/snapshot tại cả ba đích, quản lý khóa tách biệt, giới hạn retention và diễn tập restore. Bản vá này không tự cấu hình TLS/firewall, mã hóa DB dump hoặc ba đích backup, không tự chạy restore thật. Giữ quy trình tombstone/restore hiện có khi kiểm tra phục hồi hồ sơ đã hủy.

Repo không có frontend: cần tích hợp view-url, danh sách thiết bị, xử lý 429/RECENT_AUTH_REQUIRED, viewer ẩn nút tải/in nếu chính sách yêu cầu và kiểm tra XSS; không chèn HTML người dùng trực tiếp. Watermark tên Việt được chuyển ASCII do giới hạn font hiện tại. Chưa có SIEM/cảnh báo email tự động hay audit hash chain; hiện cảnh báo qua log vận hành và trả 429, chưa tổng hợp hành vi theo từng user dài hạn.

Idle ở backend được tính từ request hợp lệ, gồm refresh; nếu frontend tự poll/refresh nền thì cần thêm kiểm tra thời gian thao tác thực của người dùng tại frontend để tự logout khi không dùng trình duyệt.

`npm audit` đã được chạy và một số dependency được vá; bcrypt nâng lên 6 để loại node-pre-gyp/tar, theo [release notes chính thức](https://github.com/kelektiv/node.bcrypt.js/releases/tag/v6.0.0). Kết quả sau cập nhật: 30 cảnh báo (12 high, 14 moderate, 4 low), không còn critical; gồm cả dev dependencies. Các nhóm còn lại có Nest/Express/Multer, Nodemailer và công cụ build; cần đợt nâng version và kiểm thử tương thích riêng, không sử dụng `npm audit fix --force` trên production. Lưu bản báo cáo cập nhật bằng `npm audit --json` trong CI/kho bảo vệ và chạy định kỳ.

## Kiểm thử

```powershell
npm run test:security
npm run test:auth-sessions
npm run test:destruction
npm run test:destruction-local
node scripts/test-document-review-permissions.cjs
node scripts/test-upload-conflicts.cjs
```

Các bài kiểm thử dùng file tạm, fake DB/SMTP/scanner hoặc SQLite WAL tạm. Chúng kiểm tra mã hóa/tag/checksum, phiếu/token, audit, limiter và nghiệp vụ; không chứng nhận cấu hình ACL/TLS/ClamAV thật hay tranh chấp InnoDB trên server.

## Lỗi 500 chập chờn khi chuyển trang: deadlock limiter

Nếu log có `Deadlock found when trying to get lock` khi dashboard tải nhiều API cùng lúc, bản limiter cũ có thể gây tranh chấp: `INSERT IGNORE` giữ shared lock trên dòng trùng rồi các request cùng nâng lên exclusive lock bằng `SELECT FOR UPDATE`. Xem [quy tắc khóa InnoDB](https://dev.mysql.com/doc/refman/8.0/en/innodb-locks-set.html).

Bản sửa dùng `INSERT ... ON DUPLICATE KEY UPDATE` để lấy exclusive lock ngay từ đầu, giữ nguyên bộ đếm và cửa sổ giới hạn; deadlock đã rollback được thử lại tối đa hai lần. Lỗi storage kéo dài trả 503 với mã `RATE_LIMIT_STORAGE_UNAVAILABLE`, không mở quyền truy cập khi chưa kiểm tra được giới hạn. Không đổi schema.

Cập nhật `src/security/security.module.ts`, dừng backend, build rồi khởi động lại đúng môi trường PM2 đang sử dụng. Kiểm tra chuyển trang và các request song song. Bộ `test:security` kiểm tra retry/fail-closed/HTTP; để xác minh InnoDB thật, sau build chạy `node scripts/test-rate-limit-concurrency.cjs` bằng tài khoản test có quyền CREATE/DROP. Script tạo rồi xóa một bảng thử tên ngẫu nhiên, không sửa bảng limiter thật hoặc hồ sơ/tài khoản/audit, thực hiện 3 đợt 120 request song song từ hai instance limiter và xác minh số request được phép/bị chặn.
