# API báo cáo cho Trưởng khoa

Các API dưới đây dùng Bearer JWT phiên đăng nhập. `JwtStrategy` đọc lại vai trò và khoa từ DB ở mỗi request. Admin nhận báo cáo toàn hệ thống; Trưởng khoa nhận dữ liệu thuộc khoa hiện tại của tài khoản. Query `departmentId` không được dùng để chọn khoa khác. Người dùng thường bị từ chối; Trưởng khoa chưa gán khoa nhận HTTP 403 trước khi truy vấn dữ liệu báo cáo.

## Thống kê

| API GET | Nội dung / query |
| --- | --- |
| `/stats/overview` | Tổng hồ sơ, người dùng trong khoa, số khoa, dung lượng đã lưu và phân bố trạng thái |
| `/stats/by-department` | Trưởng khoa chỉ nhận dòng của khoa mình |
| `/stats/by-year?year=2026` | Số hồ sơ và dung lượng theo 12 tháng; mặc định năm hiện tại |
| `/stats/storage-growth` | Dung lượng tăng theo tháng và tích lũy |
| `/stats/top-uploaders?limit=10` | Người tải lên hồ sơ thuộc khoa; limit 1–100 |
| `/stats/by-document-type` | Phân bố loại hồ sơ và số chưa có loại |
| `/stats/by-classification` | Phân bố giá trị hồ sơ |
| `/stats/review-progress` | Tiến độ chỉnh lý hồ sơ cũ thuộc khoa |
| `/stats/expiring-soon?days=180` | Hồ sơ đã lưu sắp hết hạn, dạng `{total,withinDays,data}` |

Lọc năm áp dụng cho `/stats/by-year`; các báo cáo tổng quan và phân bố hiện dùng toàn bộ thời gian, theo hợp đồng API hiện có. `year` là số nguyên 1900–9999, `days` là số nguyên 1–36500.

## Giám sát nghiệp vụ

| API GET | Nội dung / query |
| --- | --- |
| `/system/missing-checksums?page=1&limit=20` | Hồ sơ chưa có SHA-256 (null/rỗng), loại trừ hồ sơ đã hủy; trả `{data,total,page,limit}` |
| `/retention/expiring?days=180` | Hồ sơ sắp hết hạn thuộc khoa; trả mảng |
| `/retention/pending-review?page=1&limit=20` | Hồ sơ cũ chưa hoàn thành chỉnh lý; trả `{data,total,page,limit,deadline,daysToDeadline}` |
| `/retention/review-summary` | Tổng hợp tiến độ chỉnh lý thuộc khoa |
| `/system/audit-logs?page=1&limit=20` | Trưởng khoa chỉ nhận lịch sử approve/reject/auto-approve của hồ sơ thuộc khoa; hỗ trợ thêm `action`, `userId`, `documentId` |

`page` là số nguyên 1–1000000, `limit` là số nguyên 1–100. Bộ lọc document/người dùng không thay thế điều kiện khoa. Log không gắn hồ sơ hoặc gắn hồ sơ khoa khác không được trả về cho Trưởng khoa, kể cả người thực hiện log thuộc khoa của họ. Metadata log của Trưởng khoa chỉ gồm lý do từ chối nếu có; không trả đường dẫn vật lý hoặc metadata nội bộ. Admin vẫn nhận log theo hợp đồng hiện có.

Trưởng khoa không được gọi `/system/status`, `/system/health`, `/system/verify-checksums`, backup, restore-test, thay đổi legal hold hoặc cập nhật trạng thái chỉnh lý qua các API quản trị. Trang Giám sát của Trưởng khoa nên dùng API thiếu checksum và báo cáo nghiệp vụ ở bảng trên; không dùng API quét toàn bộ file server.

## Kiểm tra và triển khai

```cmd
npm run test:department-reports
```

Test dùng SQL MySQL do TypeORM sinh, thực thi trên SQLite tạm trong bộ nhớ với dữ liệu hai khoa: kiểm tra tổng hợp, phân trang, ranh giới biểu thức OR/ngày null, log chéo khoa, metadata, từ chối khi chưa có khoa, quyền thao tác và vai trò/khoa được đọc lại từ DB thay vì tin thông tin trong token. Không kết nối MySQL thật hoặc đọc file nội dung. Node cần hỗ trợ `node:sqlite` (22.13+).

Sau khi đồng bộ source lên server, build và reload môi trường đang vận hành. Server HTTP nội bộ hiện tại dùng:

```cmd
npm run build
pm2 startOrReload ecosystem.config.js --env development --update-env
```

Kiểm tra qua giao diện hoặc Bearer JWT thực: Admin, Trưởng khoa khoa A, Trưởng khoa khoa B và tài khoản chưa có khoa. Frontend nằm ở repository khác, chưa được sửa trong thay đổi backend này; đối chiếu `department-reports.js` với hợp đồng API trên trước nghiệm thu giao diện. Production HTTPS dùng môi trường production đã cấu hình tương ứng.
