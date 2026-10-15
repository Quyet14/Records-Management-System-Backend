# Phân quyền theo độ mật

Độ mật là một lớp giới hạn bổ sung. Quyền theo khoa, phạm vi công khai/nội bộ/riêng tư,
trạng thái duyệt và quy định cấm user tải file vẫn được áp dụng.

| Độ mật | Người được vượt qua kiểm tra độ mật |
| --- | --- |
| Thường (`normal`) | Theo quyền truy cập hiện có |
| Mật (`confidential`) | Admin, người tải lên, trưởng khoa cùng khoa với tài liệu |
| Tối mật (`secret`) | Admin và người tải lên |
| Tuyệt mật (`top_secret`) | Admin và người tải lên |

Quyền `approve_documents` không tự mở quyền xem tài liệu mật của người khác.
Người phê duyệt phải vừa có quyền duyệt, vừa vượt qua kiểm tra độ mật.
Trưởng khoa chỉ duyệt được tài liệu Tối mật/Tuyệt mật nếu đồng thời là người tải lên;
những tài liệu Tối mật/Tuyệt mật còn lại do Admin duyệt.

Các kiểm tra áp dụng cho danh sách/tìm kiếm, chi tiết, xem/tải file và link tải,
hàng chờ phê duyệt, duyệt/từ chối, xuất Excel/PDF, tra cứu theo tag, thông báo
và các API yêu cầu xem cũ. Yêu cầu xem đã duyệt không vượt qua độ mật mới.
Chỉ Admin được hạ độ mật hoặc chuyển tài liệu sang khoa khác.

## Dữ liệu hiện có

Không đổi cấu trúc database: tiếp tục dùng cột `documents.security_level`.
Giá trị tiếng Việt như `Mật`, `Tối mật`, `Tuyệt mật` và các mã
`mat`, `toi_mat`, `tuyet_mat` vẫn được nhận diện. Bản ghi NULL/rỗng được coi là Thường.
Giá trị cũ không nhận diện được chỉ cho Admin/người tải lên truy cập đến khi Admin sửa lại.
Upload mới và cập nhật sử dụng bốn mã chuẩn trong bảng trên; giá trị không hợp lệ trả HTTP 400.
Upload nhiều file nhận `securityLevel` chung cho cả lượt tải lên.

## Triển khai trên server

Cập nhật đầy đủ thư mục `src` của bản sửa, bao gồm file mới
`src/common/document-security.ts`. Không chỉ chép riêng controller/service tài liệu:
các API xuất báo cáo, tag, thông báo và yêu cầu xem cũng có thay đổi.

```bat
npm run build
pm2 restart lths-backend --update-env
```

Kiểm tra bằng các tài khoản khác nhau cho cùng một tài liệu Mật/Tối mật/Tuyệt mật,
bao gồm người tải lên, trưởng khoa cùng khoa, trưởng khoa khác khoa và user được giao quyền duyệt.

## Kiểm tra tự động không cần database

```bat
npm run build
node scripts/test-document-security.cjs
node scripts/test-document-review-permissions.cjs
```

Bộ kiểm tra SQL chạy thêm trên SQLite trong bộ nhớ nếu Node hỗ trợ `node:sqlite`.
Đây là kiểm tra tự động cục bộ; không thay thế kiểm tra với MySQL và ứng dụng trên server.
