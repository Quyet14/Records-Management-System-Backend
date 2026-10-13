# LTHS data pipeline

Script chinh: `scripts/data-pipeline.js`.

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
