# Bản tài liệu mở trực tiếp trên ổ đĩa

Đặt `DOCUMENT_READABLE_DIR=E:/LTHS/files-readable` trong `.env` và khởi động lại backend.
Tài liệu được duyệt sẽ có thêm bản không mã hóa ở:

```text
E:\LTHS\files-readable\<ID tài liệu>\<tên tệp gốc.pdf>
```

Mở hoặc sao chép tệp này bằng File Explorer, Word, trình đọc PDF... mà không cần
đăng nhập ứng dụng. Tài liệu riêng tư tự duyệt khi upload cũng được tạo bản này.
Tài liệu chờ duyệt hoặc bị từ chối không được xuất. Các bản `.lths` và đường dẫn
trong database vẫn được sử dụng như trước. Không cần migration database.

Thư mục phải nằm ngoài dự án, web root, các kho dữ liệu, backup và nơi chứa khóa.
Ai có quyền đọc thư mục đều đọc được tài liệu, kể cả tài liệu riêng tư hoặc có
mức độ bảo mật. Cấp quyền NTFS chỉ cho tài khoản dịch vụ và người quản trị cần
truy cập. Không đặt trong thư mục public của IIS/nginx/Apache.

Mỗi ID có thư mục riêng nên tài liệu trùng tên không ghi đè nhau. Nội dung được
giải mã, kiểm tra checksum đầy đủ trước khi công bố tệp. Lỗi ghi hoặc giải mã làm
thao tác duyệt thất bại; tệp đã có nhưng khác checksum không bị ghi đè. Không sửa
tệp tại đây; hãy sao chép ra nơi khác trước khi chỉnh sửa.

## Xuất tài liệu đã duyệt trước đây

Không tự xuất toàn bộ dữ liệu khi backend khởi động. Có thể chạy công cụ riêng
không cần khởi động API; cần Node.js, bản build, cấu hình database và khóa mã hóa:

```powershell
npm run build
npm run documents:export-readable
```

Lệnh trên chỉ đếm tài liệu đủ điều kiện (`eligible`); `created: 0` là bình thường
vì chưa xuất thật. Để xuất thật, dừng API, worker, backup và import (giữ MySQL chạy),
sau đó chạy:

```powershell
npm run documents:export-readable -- --apply --processes-stopped
```

`--processes-stopped` xác nhận bạn đã dừng các tiến trình trên; lệnh không tự dừng
chúng. Công cụ tự tạo cờ maintenance riêng và tự gỡ khi kết thúc, kể cả khi xuất lỗi.
Nếu đã có cờ maintenance từ phiên khác, công cụ dừng và giữ nguyên cờ đó; không
xóa cờ của phiên restore/import đang có để chạy xuất tệp.

Lệnh bỏ qua tài liệu đang thuộc đề nghị hủy hoặc đã bắt đầu hủy. Chạy lại sẽ kiểm
tra bản đã tồn tại và tiếp tục các bản chưa có. Sau khi hoàn tất, khởi động lại dịch vụ.
Nếu tiến trình bị tắt đột ngột, cờ có thể còn lại; kiểm tra tiến trình và nội dung
`maintenance.json` trước khi xử lý, phân biệt phiên `export-readable` với restore/import.

## Hủy và phục hồi

Provider hủy local xóa thư mục bản gốc của tài liệu trước khi xóa nội dung chính;
phục hồi có tombstone cũng dọn bản gốc tương ứng. Giữ nguyên cấu hình thư mục này
cho API, worker và công cụ restore. Nếu đổi đường dẫn hoặc tắt cấu hình, các bản
đã xuất ở thư mục cũ vẫn còn và cần quản trị riêng. Các bản sao người dùng tự chép
sang nơi khác không thuộc phạm vi dọn tự động. Không đưa thư mục này vào backup
riêng chưa có quy trình hủy/restore tương ứng.

Để ngừng tạo bản mới, đặt `DOCUMENT_READABLE_DIR=` rồi khởi động lại backend.
Việc này không tự xóa các bản đã tạo.
