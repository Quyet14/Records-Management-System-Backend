# Chạy hủy hồ sơ trực tiếp trên server Windows

`DESTRUCTION_PROVIDER=local` dùng ngay backend NestJS, SMTP hiện có, ClamAV hoặc Microsoft Defender và filesystem/UNC. **Không cần dịch vụ HTTP gateway riêng và không điền địa chỉ Default Gateway của ipconfig.** Chế độ `gateway` trước đây vẫn dùng được nếu cần một adapter chuyên biệt cho cloud/NAS có version ẩn.

## Khả năng và giới hạn

### Khi chỉ lưu trên ổ đĩa và SQL

File gốc trên ổ đĩa và metadata trong SQL là dữ liệu chính. Phải xác định riêng thư mục backup; không khai báo thư mục file gốc là backup. Đường dẫn trong `.env.example` chỉ là mẫu, không chứng minh server đang dùng đường dẫn đó.

Để in **chỉ đường dẫn** đã cấu hình, không in mật khẩu/secret và không kết nối DB:

```cmd
cd /d E:\xampp\htdocs\LTHS-BACKEND
npm run build
node scripts/check-destruction.cjs --paths
```

Nếu thực tế chỉ có một kho backup trên đĩa và không có bản sao cloud/NAS, dùng mẫu [destruction.disk-only.example.json](../deploy/destruction.disk-only.example.json). Sao chép mẫu này thành `deploy/destruction.local.json` **khi tạo cấu hình lần đầu**; nếu đã có cấu hình thì đối chiếu và sửa, tránh ghi đè. Điền version chính sách, root backup thực tế, số ngày purge được phê duyệt và xác nhận authoritative cho kho đang dùng. Cloud/NAS để `enabled:false`, `root:""`, `purgeWithinDays:0`, kèm notes giải thích. Backend vẫn trả đủ ba khóa cho giao diện, nhưng kho không dùng có trạng thái `not_used`, không có hạn purge hoặc bằng chứng xóa giả.

Không được chuyển một kho đã khởi tạo sang “không sử dụng” để bỏ qua dữ liệu hoặc tombstone cũ; thay đổi tập kho cần quy trình di chuyển có kiểm soát. SQL metadata/chứng từ/audit vẫn được giữ sau hủy. Bản dump SQL có chứa nội dung file/blob ngoài chứng từ cần adapter kiểm kê riêng trước khi bật; filesystem provider chỉ quản lý file nội dung trong archive/versions và các bản mirror được khai báo.

Khi còn `NOT READY`, đặt `.env` là `DESTRUCTION_ENABLED=false` và đồng bộ PM2:

```cmd
set DESTRUCTION_ENABLED=false
pm2 startOrReload ecosystem.config.js --env production --update-env
```

PM2 `online` chỉ xác nhận tiến trình đang chạy. Nếu chưa có backup riêng thì chưa thể hoàn tất kiểm tra readiness bằng cách khai báo ba kho giả.

- OTP gửi tới email đã lưu của Admin qua SMTP, không in mã ra log, không cho browser chọn người nhận.
- Parse PDF bằng pdf-lib; chạy scanner đã cấu hình trước khi lưu chứng từ. Kiểm tra readiness có thực hiện scan một file probe vô hại để xác nhận engine và database virus dùng được.
- Kiểm kê originals, `files.storage_key`, `documents.storage_path`, `document_versions`; kiểm tra sở hữu cả documents/versions/personal_files. Chặn file dùng chung, hard link, symlink/junction, path traversal, hash đổi và file mất khi chưa có checkpoint.
- File chỉ được xóa sau đủ duyệt, đủ 24 giờ, không legal hold và có tombstone cho mọi đích đang sử dụng. Mỗi lần unlink có intent/receipt được commit SQLite WAL `synchronous=FULL`. SQLite nằm trên ổ local, ngoài kho nội dung và ngoài DB MySQL có thể bị restore.
- Worker có heartbeat, lease và kiểm tra quyền xử lý ngay trước mỗi lần xóa; nhiều PM2 worker dùng MySQL named lock chung cho các thao tác lưu trữ. HMAC/OTP/audit vẫn nằm trong transaction nghiệp vụ như trước.
- Backup mới dùng snapshot đã lọc tombstone, ghi thế hệ `lths-managed/<session-id>/...` vào mọi kho đang sử dụng và kiểm tra checksum từng bản sao. Không nhận bản sao thành công chỉ từ lệnh copy kết thúc.
- Purge kiểm kê cả file trực tiếp và các thư mục backup có timestamp với cùng relative object key; không xóa file khác. Backup đang copy giữ fence để purge không báo xong khi dữ liệu còn có thể được ghi lại. Purge tiếp tục khi tắt tạo đề nghị hoặc SMTP/scanner lỗi, trừ lúc restore đang bảo trì.
- **Filesystem provider chỉ hỗ trợ kho authoritative có cấu trúc mirror và `versioning: "none"`.** Mount/cache của Google Drive/OneDrive có thùng rác/revision ẩn, S3 versioning, NAS snapshot ẩn hoặc backup ngoài ba root chưa được bao phủ thì không được khai báo là đã hỗ trợ. Khi có những đích này, dùng `gateway` với adapter kiểm kê/purge đúng API của provider.
- Repo hiện không có dịch vụ lưu OCR/thumbnail/index riêng. `inventoryScope: "database-files-only"` là xác nhận vận hành rằng không có kho nội dung phụ ngoài originals/versions đã biết. Nếu triển khai có những kho đó, cần nối adapter trước khi bật.

## Chuẩn bị cấu hình trên server

Trong CMD:

```cmd
cd /d E:\xampp\htdocs\LTHS-BACKEND
node --version
npm run build
if not exist deploy\destruction.local.json copy deploy\destruction.local.example.json deploy\destruction.local.json
notepad deploy\destruction.local.json
```

Cần Node.js **22.13 trở lên có `node:sqlite`**. Không thay đổi `.env.example` để cấu hình instance; sửa **`.env` thực tế**:

```dotenv
DB_SYNCHRONIZE=false
DESTRUCTION_ENABLED=false
DESTRUCTION_PROVIDER=local
DESTRUCTION_LOCAL_CONFIG=./deploy/destruction.local.json
DESTRUCTION_STATE_DIR=E:/LTHS/destruction-state
DESTRUCTION_BACKUP_STAGING_ROOT=E:/LTHS/destruction-backup-staging
DESTRUCTION_OTP_SECRET=<chuoi-ngau-nhien-it-nhat-32-ky-tu>
DESTRUCTION_SCANNER_PATH=C:/Program Files/ClamAV/clamscan.exe
```

Sinh secret trên server rồi lưu trong `.env`, không đưa vào chat/log/commit:

```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Giữ SMTP_HOST/PORT/SECURE/USER/PASS/FROM đang sử dụng. Server cần gửi email SMTP được và người duyệt có email chính xác. Chế độ hủy không dùng fallback in OTP ra console của luồng auth cũ.

`deploy/destruction.local.json` là cấu hình riêng của server, đã được gitignore. Với từng external/cloud/nas **đang sử dụng**:

1. Điền `root` là thư mục **đã tồn tại**, đúng kho sao lưu authoritative. `BACKUP_DIR` của hệ thống và mọi `BACKUP_LOCAL_TARGETS` phải nằm trong một trong ba root đó. Ví dụ nếu BACKUP_DIR là `E:/LTHS/uploads/backup` thì có thể dùng chính thư mục đó làm root external.
2. Điền `purgeWithinDays` là số nguyên dương theo chính sách đã phê duyệt, không tự lấy một số ví dụ làm chính sách thật.
3. Điền version policy thực. Chỉ đổi `authoritative` thành true sau khi xác nhận kho này bao phủ dữ liệu thực tế, không có revision/snapshot ẩn. Các placeholder trong example chủ động không hợp lệ để tránh bật nhầm.
4. Root NAS có thể là UNC, ví dụ JSON `"root": "\\\\nas-server\\LTHS-Backup"`. Tài khoản chạy PM2/Task Scheduler phải có quyền đọc/ghi/xóa; ổ map của phiên desktop thường không hiện trong Windows service.
5. Archive, staging upload, personal storage, journal, staging backup và các target root đang dùng phải tách biệt, không lồng nhau. Journal cần trên ổ local NTFS, không đặt trên UNC/NAS. Không đặt chứng từ/nhật ký vào manifest nội dung cần hủy.

Nếu đang có RCLONE_REMOTES/BACKUP_TARGETS tới kho khác, chế độ local sẽ báo chưa sẵn sàng. Không xóa các khai báo này để che một kho backup đang tồn tại; chuyển dữ liệu/quy trình sang các root đã được hỗ trợ hoặc dùng adapter gateway kiểm kê đủ các remote đó.

## Scanner, DB và quyền truy cập

### Dùng Microsoft Defender trên Windows Server

Nếu server đã có Defender hoạt động, không cần cài thêm ClamAV. Trong `.env` thực tế:

```dotenv
DESTRUCTION_SCANNER=defender
DESTRUCTION_DEFENDER_PATH=
DESTRUCTION_ENABLED=false
```

`DESTRUCTION_SCANNER_PATH` chỉ dùng cho ClamAV, được bỏ qua khi chọn Defender. Nếu không khai báo `DESTRUCTION_SCANNER`, backend vẫn dùng ClamAV để tương thích cấu hình cũ. `DESTRUCTION_DEFENDER_PATH` để trống thì backend tự chọn `MpCmdRun.exe` trong phiên bản platform mới nhất có sẵn, rồi mới tìm trong `Program Files/Windows Defender`. Có thể điền đường dẫn tuyệt đối tới `MpCmdRun.exe` nếu cần chỉ định riêng.

Backend kiểm tra `Get-MpComputerStatus`: dịch vụ và antivirus phải bật, signature version phải có, `DefenderSignaturesOutOfDate` phải là false. Mỗi file được quét bằng custom scan `-Scan -ScanType 3 -File <absolute-path> -DisableRemediation`. Theo [tài liệu Microsoft](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus), tùy chọn này bỏ qua file exclusions và không áp dụng hành động xử lý sau phát hiện. Exit code khác 0, timeout, lỗi quyền, file mất hoặc thay đổi sau scan đều chặn chứng từ. Backend không thay đổi thiết lập Defender hoặc thêm exclusions. Bảo vệ thời gian thực của Windows vẫn hoạt động theo chính sách hiện có.

Chạy PowerShell trên server với quyền phù hợp (Microsoft yêu cầu MpCmdRun chạy trong cửa sổ elevated). Kiểm tra readiness phải thành công **bằng tài khoản chạy backend/PM2**, không chỉ bằng một tài khoản quản trị khác:

```powershell
Set-Location 'E:\xampp\htdocs\LTHS-BACKEND'
npm run build
$env:DESTRUCTION_SCANNER = 'defender'
$env:DESTRUCTION_ENABLED = 'false'
npm run destruction:check
```

Nếu dữ liệu nhận diện virus lỗi thời, người vận hành có thể chạy `Update-MpSignature` trong PowerShell có quyền; backend không tự chạy cập nhật hoặc nâng quyền. Khi readiness đạt READY và đã nghiệm thu tài khoản runtime, đặt `.env` và biến môi trường của phiên PowerShell thành enabled rồi reload:

```powershell
$env:DESTRUCTION_ENABLED = 'true'
pm2 startOrReload ecosystem.config.js --env production --update-env
```

Không chạy `npm run destruction:init` lại chỉ để chuyển scanner; không cần sửa migration hoặc marker kho backup. Giữ cơ chế cập nhật signature của Defender hoạt động theo chính sách Windows. Chi tiết trạng thái xem [Get-MpComputerStatus](https://learn.microsoft.com/en-us/powershell/module/defender/get-mpcomputerstatus).

### Dùng ClamAV

Cài ClamAV, cấu hình và cập nhật database virus bằng FreshClam theo [tài liệu chính thức](https://docs.clamav.net/manual/Usage/SignatureManagement.html). [Hướng dẫn scan](https://docs.clamav.net/manual/Usage/Scanning.html) dùng `clamscan`; trên Windows executable thường có hậu tố `.exe`. Backend gọi executable bằng `execFile`, không qua shell và không thêm tùy chọn xóa/quarantine chứng từ.

MySQL `max_allowed_packet` cần ít nhất **64 MiB** để lưu PDF 25 MiB trong transaction. Dùng tài khoản migration riêng để cài trigger; tài khoản chạy app không nên có DROP/ALTER/TRIGGER. Chứng từ giữ trong bảng riêng có trigger append-only. Phân quyền NTFS cho state/staging để chỉ tài khoản dịch vụ và người vận hành được đọc/ghi; account người dùng/frontend không có quyền sửa trực tiếp file archive trong lúc worker kiểm tra/xóa.

Vì backend nằm dưới `htdocs`, đã thêm `.htaccess` cấm Apache phục vụ trực tiếp source/.env/storage. XAMPP phải cho phép directory rule này; kiểm tra truy cập file backend qua cổng Apache trả 403. NestJS API ở cổng 3002 hoạt động riêng. Nếu Apache không đọc `.htaccess`, cài quy tắc tương đương trong VirtualHost trước khi bật dịch vụ.

## Kiểm tra và bật dịch vụ

Chỉ khi migration chưa áp dụng, sao lưu DB trước rồi chạy `npm run db:add-destruction`. Không cần migration SQL mới riêng cho chế độ local; nhật ký SQLite được khởi tạo bởi lệnh dưới:

Nếu lịch sử migration đã có nhưng readiness báo thiếu trigger, sau khi sao lưu DB chạy `npm run db:repair-destruction`. Lệnh áp dụng migration còn chờ, sau đó kiểm tra lại và bổ sung cấu trúc/trigger còn thiếu; giữ nguyên trigger đang tồn tại. Dùng tài khoản có quyền migration, không tự nâng quyền tài khoản runtime. Readiness liệt kê tên trigger còn thiếu để đối chiếu.

```cmd
npm run destruction:init
npm run destruction:check
```

`init` chỉ tạo thư mục journal/staging và marker định danh ở các root đang dùng đã có, không tạo root backup giả và không xóa tài liệu. Marker gắn với journal ID; mất journal/đổi root hoặc policy không được tự động tạo lại để bỏ qua tombstone cũ.

`check` kiểm tra SMTP, scan probe, SQLite, các root/marker, packet size và trigger. Nếu báo NOT READY, sửa đúng mục được liệt kê rồi kiểm tra lại. Không sửa code để ép enabled=true hoặc giả health. `check` có thể báo READY trong khi DESTRUCTION_ENABLED=false để nghiệm thu trước khi bật.

Sau khi READY và đã nghiệm thu staging, sửa `.env` thành `DESTRUCTION_ENABLED=true`. Đồng bộ biến trong CMD trước khi reload để ghi đè giá trị false mà PM2 có thể đã lưu từ lần chạy trước:

```cmd
set DESTRUCTION_ENABLED=true
pm2 startOrReload ecosystem.config.js --env production --update-env
pm2 logs lths-backend --lines 50
```

Kiểm tra `/destruction/capabilities` bằng Bearer JWT: provider local, enabled true, đủ ba targets; nếu chưa sẵn sàng có unavailableReasons tiếng Việt. Frontend hiện sẽ mở quy trình khi capabilities đạt điều kiện. Metadata cũ thiếu retention_until vẫn không được hủy; cần xác nhận mốc/thời hạn bảo quản như [hợp đồng workflow](destruction-workflow.md).

## Backup journal và restore

SQLite journal/tombstone phải được sao lưu **riêng**, ngoài DB có thể bị restore. Không copy mỗi file `destruction.sqlite` khi WAL đang chạy. Tạo bản nhất quán bằng lệnh sau, với một đường dẫn `.sqlite` mới trong vùng backup bảo vệ riêng:

```cmd
node scripts/check-destruction.cjs --backup-journal E:\Protected-LTHS\journal-2026-10-19.sqlite
```

Sau đó sao lưu bản snapshot này ra vùng an toàn theo chính sách của đơn vị. Snapshot chứa metadata hủy và có thể chứa chứng từ được bảo tồn trước restore; không đặt vào kho public hoặc vùng bị worker purge. Không đổi STATE_DIR/xóa SQLite để giải quyết thông báo NOT READY.

`data-pipeline.js import-mysql-dump` tạo maintenance flag dùng chung cho mọi PM2 worker trước import, bảo tồn các bảng hủy/chứng từ/audit trong journal, rồi áp tombstone trước mở lại API. Backend trả 503 trong lúc bảo trì. Restore khác với metadata bất biến hoặc có phiên bản ngoài tombstone thì giữ bảo trì để đối chiếu, không công bố nội dung cũ.

Nếu restore/import lỗi, đọc session UUID từ file `DESTRUCTION_STATE_DIR/maintenance.json`, xử lý lỗi metadata/DB rồi chạy:

```cmd
node scripts/check-destruction.cjs --resume-restore <session-uuid>
```

Chỉ khi bước chuẩn bị thất bại **trước import** (session preparing), có thể hủy bước chuẩn bị:

```cmd
node scripts/check-destruction.cjs --cancel-preparing-restore <session-uuid>
```

Không xóa maintenance.json bằng tay để mở lại dữ liệu. Những session backup bị crash giữ fence cho purge đến khi được kiểm tra và đóng đúng session; không tự hết hạn một tác vụ còn có thể copy dữ liệu.

Xem các session bằng `node scripts/check-destruction.cjs --list-sessions`. Chỉ sau khi xác nhận tiến trình backup tương ứng đã dừng, đóng session lỗi bằng:

```cmd
node scripts/check-destruction.cjs --close-backup-session <session-uuid> --confirm-stopped
```

Lệnh ghi nhận session thất bại và dọn snapshot tạm của chính session đó, không báo backup thành công. Khi cần tắt dịch vụ, đặt cả `.env` và biến CMD DESTRUCTION_ENABLED=false rồi reload PM2 tương tự; tránh giữ giá trị true cũ trong môi trường PM2.

## Hồ sơ biến mất khỏi kho nhưng chưa có trong “Đã hủy”

Worker đặt `destruction_started_at` khi nhận việc để khóa nội dung khỏi kho và API đọc file. Chỉ khi có receipt xác minh xóa thành công, worker mới đặt trạng thái `destroyed` để hiện trong “Đã hủy”. Nếu đề nghị `failed` và item còn `pending`, chưa có manifest đã kiểm kê được lưu trong DB; việc hồ sơ không còn trong kho không chứng minh file đã được xóa.

Chạy trên server sau khi cập nhật source và build:

```cmd
node scripts/check-destruction.cjs --document <document-uuid>
pm2 logs lths-backend --lines 100 --nostream
```

Lệnh kiểm tra chỉ đọc, in trạng thái document/request/item/job, checkpoint và lỗi đã lưu; không in mật khẩu hoặc nội dung chứng từ. Worker mới lưu mã lỗi và bước lỗi vào `job.last_error`, ví dụ `[inventory:CONTENT_HASH_CHANGED]`. Lỗi cũ cần đối chiếu log PM2 tại thời điểm xử lý. Không tự đổi `status=destroyed`, xóa `destruction_started_at`, manifest hoặc SQLite để làm hồ sơ xuất hiện. Sau khi xử lý nguyên nhân và kiểm tra journal/receipts, dùng `scripts/retry-destruction.cjs` với request, tài khoản admin vận hành và lý do; lệnh giữ checkpoint để tiếp tục xác minh kết quả hủy.

Với provider local và đề nghị lỗi, lệnh còn kiểm tra file gốc/phiên bản: `hardLinks` là số liên kết filesystem, `SHARED WITH` liệt kê ID hồ sơ/kho cá nhân khác đang trỏ cùng file. `SHARED_CONTENT` có thể là chia sẻ file thật (upload trùng được deduplicate), hard link hoặc lỗi so sánh inode ở bản cũ. Bản mới so sánh file ID bằng BigInt để tránh làm tròn ID NTFS lớn. Nếu còn tham chiếu thật, cần xử lý sở hữu nội dung dùng chung trước khi thử lại; không bỏ chặn bằng cách ép trạng thái hủy.

## Kiểm thử đã có

### Giữ hồ sơ lưu kho và hủy một hồ sơ dùng chung file

Với đề nghị đã lỗi ở bước kiểm kê (`item=pending`, chưa có checkpoint/tombstone), dùng `scripts/separate-retained-content.cjs`. Lệnh mặc định chỉ xem trước, kiểm tra checksum và liệt kê admin đang hoạt động. `--apply` tạo bản sao độc lập trong archive cho hồ sơ cần giữ, xác minh cả bytes vật lý và checksum nội dung (hỗ trợ container mã hóa), đồng bộ đường dẫn các phiên bản dùng chung, rồi ghi audit trong transaction. Hồ sơ giữ tiếp tục ở trạng thái lưu kho và dùng đường dẫn riêng với `file_id=NULL`, theo cơ chế đọc file độc lập hiện có. Không cần migration hoặc sửa trigger. File gốc, bảng `files` đã bị đóng băng và snapshot/OTP/lượt duyệt của hồ sơ cần hủy được giữ nguyên.

Ví dụ đúng hai hồ sơ đã đối chiếu:

```cmd
npm run build
node scripts/separate-retained-content.cjs --destroy 47526d2c-b80f-417b-ac1b-d7dfe10b86b0 --keep 7dcf644a-5a0e-45e1-b8d1-0891fc1b65dc
```

Nếu nguồn là file cũ chưa mã hóa, lệnh kiểm kê dùng checksum tin cậy của snapshot để xác minh mà không bật `ARCHIVE_ALLOW_LEGACY_READ`. Khi mã hóa archive đang bật, bản giữ lại được mã hóa thành `.lths` bằng keyring hiện có, rồi xác minh nội dung sau giải mã; file gốc vẫn nguyên trạng cho worker hủy. `encryptLegacyObjects` trong kết quả cho biết số object cần chuyển đổi. Cần cấu hình keyring hợp lệ trước khi áp dụng; không chạy chuyển đổi toàn kho lên hồ sơ đang bị đóng băng cho đề nghị hủy.

Để lấy UUID admin ngay cả khi việc kiểm kê chưa qua:

```cmd
node scripts/separate-retained-content.cjs --list-admins
```

Chọn ID admin thực từ kết quả, thay `ADMIN_UUID` trong các lệnh sau:

`ADMIN_UUID` là chỗ giữ chỗ, không phải ID hợp lệ. Chạy từng lệnh trên một dòng riêng, kết thúc `--apply` rồi nhấn Enter trước khi chạy `node scripts/check-destruction.cjs`; không ghép thành `--applynode`.

```cmd
node scripts/separate-retained-content.cjs --destroy 47526d2c-b80f-417b-ac1b-d7dfe10b86b0 --keep 7dcf644a-5a0e-45e1-b8d1-0891fc1b65dc --actor ADMIN_UUID --reason "Giu ho so luu kho, tach file truoc khi huy ho so trung" --apply
node scripts/check-destruction.cjs --document 47526d2c-b80f-417b-ac1b-d7dfe10b86b0
node scripts/check-destruction.cjs --document 7dcf644a-5a0e-45e1-b8d1-0891fc1b65dc
```

Hồ sơ cần hủy phải có `otherReferences=0`, `hardLinks=1`; hồ sơ cần giữ vẫn `stored`/`approved`, xem PDF được. Sao lưu DB và archive sau khi tách bằng quy trình backup hiện có (ví dụ `npm run data:backup-sync` nếu server đã cấu hình đầy đủ); xác nhận backup thành công trước khi requeue, vì bản backup trước tách chưa chứa đường dẫn bản sao mới. Sau đó:

```cmd
pm2 startOrReload ecosystem.config.js --env production --update-env
node scripts/retry-destruction.cjs --request 4a8062aa-8681-477b-83cc-6fd8d3e2c6d8 --actor ADMIN_UUID --reason "Da tach va kiem tra ho so can giu, backup thanh cong" --apply
```

Worker xử lý ở chu kỳ tiếp theo khi đủ điều kiện. Kiểm tra lại: hồ sơ yêu cầu phải chuyển sang `destroyed` và hiện ở “Đã hủy”; hồ sơ giữ vẫn đọc được. Không tự rút ngắn thời gian chờ hoặc thay bằng chứng duyệt.

Lệnh tách dừng nếu có hồ sơ thứ ba/kho cá nhân/hard link, legal hold, metadata không đồng nhất, checksum sai hoặc checkpoint hủy đã tồn tại. Nếu lỗi transaction/kết nối sau khi copy, giữ bản sao để tránh xóa nhầm khi chưa biết commit đã thành công hay chưa; chạy lại chế độ xem trước và đối chiếu audit. File gốc không bị lệnh tách xóa. Việc thử lại sau tách thành công là no-op. Lệnh không đổi cơ chế deduplicate cho các lần upload mới.

Kiểm thử riêng:

```cmd
npm run build
node scripts/test-separate-retained-content.cjs
```

## Kiểm thử workflow

### Đề nghị lỗi INVALID_APPROVALS và không có lượt duyệt trong DB

Nếu chẩn đoán báo `required=1`, `recorded=0`, audit “đã duyệt OTP” không thay thế được bản ghi trong `destruction_approvals`. Không chèn lượt duyệt giả hoặc requeue liên tục. Dùng `scripts/reopen-destruction-approval.cjs` để mở lại bước duyệt OTP thật. Lệnh kiểm tra tài khoản admin, snapshot, toàn bộ item và journal gốc; chỉ nhận đề nghị/job `failed`, không lease, không checkpoint/receipt/tombstone và không có lượt duyệt. Giữ nguyên chứng từ, audit cũ, snapshot và `destruction_started_at`.

Sau khi cập nhật source, build và reload đúng môi trường đang vận hành (ví dụ server HTTP nội bộ hiện đang chạy development), xem trước:

```cmd
npm run build
pm2 startOrReload ecosystem.config.js --env development --update-env
node scripts/reopen-destruction-approval.cjs --request 4a8062aa-8681-477b-83cc-6fd8d3e2c6d8 --actor aad7cc0d-a8a6-11f1-bd7a-005056b755e9 --reason "Mo lai duyet OTP do DB khong co luot duyet"
```

Chỉ áp dụng nếu kế hoạch hợp lệ:

```cmd
node scripts/reopen-destruction-approval.cjs --request 4a8062aa-8681-477b-83cc-6fd8d3e2c6d8 --actor aad7cc0d-a8a6-11f1-bd7a-005056b755e9 --reason "Mo lai duyet OTP do DB khong co luot duyet" --apply
```

Tải lại chi tiết đề nghị và dùng tài khoản Admin (khác người lập) để kiểm tra chứng từ, nhận OTP và duyệt trên giao diện. Request trở về `pending`, job cũ chuyển `cancelled`; khi đủ lượt duyệt, backend lập lịch lại trên job này và giữ lịch sử số lần chạy. OTP cũ bị vô hiệu bởi version mới. Thời gian chờ đầy đủ 24 giờ được tính từ lượt duyệt mới, không dùng mốc cũ hoặc `retry-destruction.cjs` để bỏ qua. Nếu bản ghi duyệt vẫn bị mất sau khi duyệt mới, cần kiểm tra DB/restore thực tế.

```cmd
npm run test:destruction-local
node scripts/test-destruction.cjs
node scripts/test-document-security.cjs
node scripts/test-document-review-permissions.cjs
```

Test local tạo file/SQLite thật trong một cây thư mục tạm, thử crash sau unlink, reopen journal, replay receipt, file shared/hard link, symlink/junction, path traversal, hash đổi, mất checkpoint, ba target backup, cleanup snapshot, maintenance, scanner/SMTP transport giả và xuất journal nhất quán. Không gửi email hoặc xóa file server thật. MySQL/SMTP/ClamAV và mount NAS/cloud thực phải được nghiệm thu trên server; test offline không thay thế kiểm tra đó.
