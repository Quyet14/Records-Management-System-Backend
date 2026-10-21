# Dọn dữ liệu thử nghiệm trong database lths

File [reset-test-data.sql](../scripts/reset-test-data.sql) dành cho database thử nghiệm `lths` trong ảnh. Không chạy trên database nghiệp vụ thật.

Phạm vi: xóa toàn bộ hồ sơ dùng chung, file metadata, đề nghị hủy, chứng từ và lượt duyệt, job, idempotency, yêu cầu xem, lịch sử truy cập, audit và thông báo thử nghiệm. Giữ tài khoản, khoa, loại hồ sơ, tags, dữ liệu cá nhân (`personal_files`), phiên đăng nhập, cấu trúc bảng, migration, khóa ngoại và trigger.

1. Trên server, chạy `pm2 stop lths-backend`. Dừng các lệnh backup/restore thủ công nếu đang chạy.
2. Trong phpMyAdmin chọn database `lths`, dùng **Export → Custom → SQL**, xuất toàn bộ cấu trúc và dữ liệu, kèm triggers. Giữ file export trước khi dọn.
3. Chọn **Import**, chọn `scripts/reset-test-data.sql` đã đưa lên server/máy đang mở phpMyAdmin, rồi chạy. Hoặc mở file và dán **toàn bộ** vào tab SQL, chạy một lần. File chỉ nhắm vào database `lths`; nếu database thử nghiệm thực tế có tên khác, sửa dòng `USE` cho đúng trước khi chạy.
4. Kết quả cuối phải có `remaining_rows = 0` cho cả bốn bảng. Nếu có lỗi ở bất kỳ câu nào, không khởi động lại backend; giữ nguyên dữ liệu còn lại và kiểm tra lỗi để xử lý hoặc phục hồi export. `TRUNCATE` tự commit, không có rollback toàn bộ file.
5. Nếu chỉ cần dọn SQL, sau khi kiểm tra chạy `pm2 start lths-backend`, tải lại frontend. Lịch hủy cũ không còn job trong SQL để tiếp tục chạy.

Script dùng `TRUNCATE` vì nó không gọi trigger DELETE, rồi khôi phục `FOREIGN_KEY_CHECKS` ở cuối phiên. Không DROP trigger hoặc khóa ngoại; các bảo vệ tiếp tục hoạt động sau khi dọn.

## Phần SQL không xóa

PDF trên ổ đĩa, backup, SQLite journal và tombstone độc lập vẫn còn. Đây là reset database, không phải reset toàn bộ môi trường lưu trữ. Không xóa journal riêng lẻ: marker của kho backup gắn với journal, và tombstone cũ vẫn có thể áp dụng cho đường dẫn file được tải lại. Nếu cần thử lại đúng nội dung đã từng hủy, cần chuẩn bị một bộ thư mục archive/backup/state/staging mới và cấu hình local policy tương ứng trước khi thử; không trộn journal mới với backup hoặc marker cũ.

Nếu schema có bảng tùy biến khác tham chiếu các bảng bị dọn, cần bổ sung xử lý bảng đó trước khi chạy; tập bảng trong file khớp schema hiện có trong repository.
