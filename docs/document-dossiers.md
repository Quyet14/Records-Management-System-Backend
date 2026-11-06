# Bộ hồ sơ và file bổ sung

Áp dụng [migration](../scripts/add-document-dossier.sql) trước khi chạy backend mới. Chưa tự động thay đổi database.

Chạy `node scripts/apply-document-dossier-migration.cjs` để kiểm tra; thêm `--apply` để áp dụng. Script có thể chạy lại và giữ đúng collation của ID hiện tại.

- `POST /documents/upload`: gửi multipart như hiện tại, thêm `dossierRootId` là ID hồ sơ đã duyệt hoặc một file trong bộ hồ sơ đó. Mỗi lần gọi bổ sung một file; có thể gọi nhiều lần.
- Người tải hồ sơ gốc, người có quyền duyệt hồ sơ đó và admin được bổ sung. Backend kiểm tra quyền, tình trạng hủy và trạng thái đã duyệt của hồ sơ gốc.
- File bổ sung kế thừa khoa, loại hồ sơ, độ mật và phạm vi hiển thị từ hồ sơ gốc. File có trạng thái duyệt riêng theo quy trình upload hiện tại; bổ sung không thay thế file gốc.
- `GET /documents/:id/dossier?page=1&limit=20`: danh sách file trong bộ hồ sơ, gồm file gốc; từng file được kiểm tra quyền xem metadata. Kết quả gồm `dossierRootId`, `data`, `total`, `page`, `limit`.
- `GET /documents/:id`: metadata chi tiết, có thêm `dossierRootId` (null với hồ sơ gốc).

## Kết nối giao diện

Trong danh sách chờ duyệt, nút **Chi tiết** gọi API chi tiết. Trình xem file được mở rộng gần toàn màn hình, sử dụng API `GET /documents/:id/view-url` và cơ chế xác thực hiện có. Quyền xem nội dung vẫn được kiểm tra riêng.

Trong hồ sơ đã duyệt, mục **File cùng bộ hồ sơ** và nút **Bổ sung file** dùng API trên. Danh sách được làm mới sau khi upload; hiển thị trạng thái duyệt riêng cho từng file. Giao diện nằm trong repository `C:/LTHS-FRONTEND`.

Trang tải lên có nút **Xem trước** cho file đã chọn, hỗ trợ PDF và ảnh ngay trên máy trước khi gửi lên server.
