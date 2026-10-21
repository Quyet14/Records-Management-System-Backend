# LTHS data pipeline

Script chinh: `scripts/data-pipeline.js`.

Bao ve kho: build truoc khi import; `index-files`/SQL Server quet ClamAV va ma hoa vao file UUID. Khi bat ma hoa, dung `FILE_IMPORT_MODE=copy`; khong ho tro link plaintext. Xem [cau hinh khoa, migration va nghiem thu](docs/security-hardening.md). Cac vi du legacy ben duoi khong thay the cau hinh production.

## 1. Import MySQL dump vao database MySQL

```env
DB_HOST=localhost
DB_PORT=3306
DB_DATABASE=pdf_archive
DB_USERNAME=root
DB_PASSWORD=your_password

MYSQL_DUMP_FILE=D:/backup/pdf_archive.sql
```

Chay:

```bash
node scripts/data-pipeline.js import-mysql-dump
```

Can co lenh `mysql` trong `PATH`.

Windows/XAMPP co the chi dinh executable thay vi sua PATH (doi o dia neu XAMPP o noi khac):

```env
MYSQL_CLIENT_PATH=E:/xampp/mysql/bin/mysql.exe
MYSQL_DUMP_PATH=E:/xampp/mysql/bin/mysqldump.exe
```

Hai bien nay chi dinh chuong trinh, khac `MYSQL_DUMP_FILE` la file SQL nguon can restore. Khong chay `all` neu chi muon nhap PDF: `all` luon chay restore dump va migrate SQL Server. Sau khi cap nhat source, chay `npm ci` va `npm run build`; kiem tra `dist/common/archive-crypto.js` ton tai truoc khi import.

## 2. Dua PDF tu may local / SAN vao he thong

```env
FILE_IMPORT_SOURCES=D:/PDF-Nguon;//san-server/share/pdf
FILE_IMPORT_MODE=copy
FILE_IMPORT_STATUS=stored
FILE_IMPORT_DATE_SOURCE=mtime
FILE_IMPORT_UPDATE_EXISTING_DATES=true
FILE_IMPORT_UPLOADER_ID=<uuid-user-mac-dinh>
FILE_IMPORT_DEPARTMENT_ID=<uuid-khoa-neu-co>
FILE_IMPORT_DOCUMENT_TYPE_ID=<uuid-loai-ho-so-neu-co>

UPLOAD_ARCHIVE_DIR=./storage/archive
```

Chay:

```bash
node scripts/data-pipeline.js index-files
```

`FILE_IMPORT_MODE=copy` se copy PDF vao `UPLOAD_ARCHIVE_DIR` va tao record `documents`.
Khi quet thu muc cha nhu `E:/LTHS`, script tu loai archive, staging, personal, backup, destruction-state, destruction-backup-staging, cac dich backup local/policy, thu muc khoa va thu muc backend. Khong theo symlink/junction. Nen chon thu muc nguon rieng, vi du `E:/LTHS/nguon-pdf`; khong dung kho luu tru/backup lam nguon import. File tam scanner nhu `destruction-state/scan-.../attachment.pdf` khong duoc nhap vao ho so.
`FILE_IMPORT_MODE=link` chi luu duong dan goc tren o dia/SAN, khong copy file.

`FILE_IMPORT_DATE_SOURCE` quyet dinh ngay frontend thay trong archive:

- `mtime`: lay ngay sua file gan nhat, phu hop nhat khi import tu o dia/SAN.
- `birthtime`: lay ngay tao file neu he dieu hanh/SAN cung cap dung.
- `path-date`: lay ngay tu folder dang `YYYY-MM-DD`, neu khong co thi fallback ve `mtime`.
- `now`: lay ngay import hien tai.

Neu `FILE_IMPORT_UPDATE_EXISTING_DATES=true`, khi gap file trung checksum script se cap nhat lai
`document_date`, `created_at`, `approved_at` theo ngay file de archive frontend nhom dung ngay.

## 3. Migrate tu SQL Server sang MySQL

Vi du cau hinh:

```env
SQLSERVER_HOST=192.168.1.20
SQLSERVER_PORT=1433
SQLSERVER_DATABASE=LegacyArchive
SQLSERVER_USER=sa
SQLSERVER_PASSWORD=your_password
SQLSERVER_ENCRYPT=false
SQLSERVER_TRUST_CERT=true

SQLSERVER_DOCUMENT_QUERY=SELECT Title AS title, FileName AS originalFilename, FilePath AS storagePath, DepartmentId AS departmentId, UploaderId AS uploaderId, DocumentDate AS documentDate FROM LegacyDocuments
```

Chay:

```bash
node scripts/data-pipeline.js migrate-sqlserver
```

Query can tra ve toi thieu duong dan file bang mot trong cac cot:
`storagePath`, `storage_path`, `filePath`, `file_path`.

## 4. Backup MySQL + archive sang SAN/server khac

Local/SAN target:

```env
BACKUP_DIR=./storage/backup
BACKUP_LOCAL_TARGETS=Z:/LTHS-Backup;//san-server/backup/LTHS
```

Rclone target:

```env
BACKUP_TARGETS=nas:LTHS-Backup,gdrive:LTHS-Backup
```

Chay:

```bash
node scripts/data-pipeline.js backup-sync
```

Can co `mysqldump` trong `PATH`; neu dung `BACKUP_TARGETS` thi can co `rclone`.

## Chay ca 4 buoc

```bash
node scripts/data-pipeline.js all
```

Nen chay tung buoc rieng lan dau de kiem tra duong dan, quyen truy cap SAN, mapping user/phong ban/loai ho so.

# Bổ sung khi triển khai hủy hồ sơ

Các lệnh backup-sync và import-mysql-dump có kiểm soát snapshot/tombstone qua gateway khi có lịch sử đề nghị hủy. Cần build backend trước khi chạy script; xem [hướng dẫn triển khai](docs/destruction-workflow.md). Nếu gateway không sẵn sàng, tác vụ dừng để tránh sao lưu hoặc công bố lại nội dung đã hủy. Import thất bại giữ chế độ bảo trì cho vận hành xử lý.
