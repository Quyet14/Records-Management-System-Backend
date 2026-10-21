# Thiết lập backup 3 lớp cho hệ thống lưu trữ PDF

## 1. Cài rclone (chạy 1 lần, trên server chính)

- Windows: tải tại https://rclone.org/downloads/, giải nén, thêm vào PATH
- Linux: `sudo apt install rclone` hoặc `curl https://rclone.org/install.sh | sudo bash`

Kiểm tra: `rclone version`

---

## 2. Khai báo 3 remote (chạy 1 lần)

Chạy `rclone config` và làm theo hướng dẫn tương tác cho từng đích:

### a) Ổ cứng ngoài / ổ khác trên cùng máy — remote tên `local-drive`
- Type: `local`
- Không cần cấu hình gì thêm, chỉ cần biết đường dẫn gốc
  - Windows: `D:\Backups\LTHS`
  - Linux: `/mnt/backup-disk/lths`

### b) NAS / server nội bộ — remote tên `nas`
- Nếu NAS hỗ trợ SMB/CIFS: mount ổ mạng trước (map network drive trên Windows, hoặc `mount -t cifs` trên Linux), sau đó dùng type `local` trỏ vào đường dẫn đã mount
- Nếu muốn kết nối trực tiếp không cần mount: dùng type `sftp` (nếu NAS hỗ trợ SSH) hoặc `smb` (rclone bản mới hỗ trợ thẳng SMB)

### c) Cloud — remote tên `gdrive` (hoặc `s3` nếu dùng Amazon S3)
- Type: `drive` (Google Drive) — rclone sẽ mở trình duyệt để bạn đăng nhập và cấp quyền 1 lần
- Hoặc type: `s3` — cần Access Key / Secret Key từ AWS

Sau khi xong, kiểm tra từng remote:
```
rclone lsd local-drive:
rclone lsd nas:
rclone lsd gdrive:
```

---

## 3. Cấu hình file `.env` của backend (thêm các dòng sau)

```env
# Các biến DB đã có sẵn trong .env — đảm bảo đúng tên:
DB_HOST=localhost
DB_PORT=3306
DB_DATABASE=pdf_archive
DB_USERNAME=root
DB_PASSWORD=<mật khẩu MySQL>

UPLOAD_ARCHIVE_DIR=./storage/archive
BACKUP_STAGING_DIR=./backup-staging
BACKUP_RETENTION_DAYS=30

# Liệt kê đủ 3 đích, cách nhau dấu phẩy — script sẽ backup tới TẤT CẢ
RCLONE_REMOTES=local-drive:D:/Backups/LTHS,nas:LTHS-Backup,gdrive:LTHS-Backup
```

---

## 4. Chạy thử thủ công

```bash
cd <thư mục dự án LTHS-BACKEND>
node backup.js
```

Xem log in ra — nếu thấy `✅ Backup hoàn tất` là ổn. Kiểm tra lại cả 3 đích xem đã có thư mục `files/` và `db-dumps/` với dữ liệu mới chưa.

---

## 5. Lên lịch chạy tự động mỗi đêm

### Nếu server chạy Windows — dùng Task Scheduler
1. Mở **Task Scheduler** → Create Task
2. Tab **General**: đặt tên `LTHS-Backup`, chọn "Run whether user is logged on or not"
3. Tab **Triggers** → New → Daily, giờ chạy **2:00 AM**
4. Tab **Actions** → New:
   - Program: `node`
   - Arguments: `backup.js`
   - Start in: `C:\LTHS-BACKEND` (đường dẫn thư mục dự án)
5. Tab **Conditions**: bỏ chọn "Start the task only if the computer is on AC power"
6. Lưu lại, bấm **Run** để test ngay

### Nếu server chạy Linux — dùng cron
```bash
crontab -e
```
Thêm dòng:
```
0 2 * * * cd /đường/dẫn/tới/LTHS-BACKEND && /usr/bin/node backup.js >> /var/log/lths-backup.log 2>&1
```

---

## 6. Quy trình khôi phục khi có sự cố (Disaster Recovery)

### Khôi phục database
```bash
# Nếu file dump có nén .gz (Linux)
gunzip < db-pdf_archive-2026-08-26.sql.gz | mysql -u root -p pdf_archive

# Nếu file dump không nén (Windows)
mysql -u root -p pdf_archive < db-pdf_archive-2026-08-26.sql
```

### Khôi phục file PDF
Lấy từ bất kỳ đích nào còn sống (ưu tiên đích gần nhất về thời gian):
```bash
rclone copy local-drive:files ./storage/archive
# hoặc
rclone copy nas:files ./storage/archive
# hoặc
rclone copy gdrive:files ./storage/archive
```

### Sau khi khôi phục
1. Kiểm tra số lượng file khôi phục có khớp số record `status = 'stored'` trong DB không
2. Khởi động lại app NestJS, thử tải vài file ngẫu nhiên để xác nhận
3. Ghi log lại sự cố + thời điểm khôi phục vào tài liệu vận hành nội bộ

---

## Lưu ý quan trọng

- Khi đã có đề nghị hủy hồ sơ, backup/restore phải theo [quy trình tombstone và barrier](docs/destruction-workflow.md). Các lệnh restore thủ công ở trên chỉ dùng cho dữ liệu chưa có lịch sử hủy hoặc trong vùng bảo trì cách ly; trước khi mở lại ứng dụng phải áp và xác minh tombstone từ gateway. Không khởi động lại app ngay sau restore để bỏ qua bước này.

- Vì yêu cầu pháp lý là lưu trữ **nhiều năm không được mất**, nên định kỳ **(3–6 tháng/lần)** thử khôi phục thật (restore vào môi trường test) để chắc chắn bản backup dùng được — backup chưa từng thử khôi phục không đáng tin cậy.
- Mật khẩu DB trong `.env` không nên commit vào git — đảm bảo `.env` đã có trong `.gitignore`.
- Script dùng `--single-transaction` khi dump để không lock bảng, an toàn khi app đang chạy.
