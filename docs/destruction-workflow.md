# Quy trình hủy hồ sơ — backend v1

Mã nguồn triển khai các API `/destruction`, migration MySQL, OTP ngoài băng, lịch chờ 24 giờ, worker có lease/checkpoint, chứng từ bất biến và tích hợp backup/restore. Mặc định `DESTRUCTION_ENABLED=false`.

**Trạng thái triển khai:** đã có tích hợp trực tiếp `DESTRUCTION_PROVIDER=local` với filesystem/UNC, SMTP, ClamAV hoặc Microsoft Defender, SQLite WAL và các kho backup có thẩm quyền. Cloud/NAS không sử dụng có thể được khai báo rõ trong chính sách. Xem [lệnh cấu hình trên server Windows](destruction-local.md). Không còn bắt buộc chạy một gateway API riêng. Adapter `gateway` vẫn hỗ trợ tích hợp cloud/NAS có version/snapshot ẩn mà filesystem provider không kiểm kê được. Cần cấu hình và nghiệm thu hạ tầng thực trước khi bật enabled; không dùng adapter giả trong ứng dụng.

## Dữ liệu và quyền

- Admin, Trưởng khoa có khoa và user có khoa được lập đề nghị. Trưởng khoa chỉ thao tác hồ sơ thuộc khoa mình. User chỉ được chọn hồ sơ do chính mình tải lên và thuộc khoa hiện tại của mình; backend kiểm tra lại khi gửi, kể cả gửi trực tiếp ID hoặc gửi lại cùng Idempotency-Key.
- User chỉ xem danh sách, chi tiết và chứng từ của đề nghị do mình lập khi mọi hồ sơ vẫn do mình tải lên và thuộc khoa mình. Danh sách hồ sơ đủ điều kiện/đã hủy của user cũng lọc theo người tải lên và khoa trước phân trang. User được thu hồi đề nghị của mình theo trạng thái cho phép, không được cấp OTP duyệt, phê duyệt, từ chối hoặc đóng thủ tục hủy.
- Admin có quyền duyệt theo vai trò, không cần cờ `approve_sensitive_destruction`. Trưởng khoa được xem và duyệt đề nghị hủy khi mọi hồ sơ thuộc khoa mình, kể cả hồ sơ mật/tối mật/tuyệt mật. Quyền này áp dụng trong quy trình hủy; không thay đổi quyền truy cập nội dung ở API tài liệu thông thường.
- Mức thường cần một lượt duyệt của Admin hoặc Trưởng khoa. Trưởng khoa được tự lập và tự duyệt bằng OTP nếu toàn bộ hồ sơ thường trong đề nghị do chính mình tải lên và thuộc khoa mình. Các trường hợp khác không tự duyệt đề nghị của mình.
- Mức mật/tối mật/tuyệt mật hoặc mức chưa nhận diện bắt buộc một Trưởng khoa của hồ sơ và một Admin, là hai người khác nhau, không phải người lập. Không thay thế bằng hai Admin hoặc hai Trưởng khoa. Đề nghị có hồ sơ mật phải thuộc cùng một khoa; hồ sơ khác khoa cần tách đề nghị.
- Quyền hiện tại, vai trò và khoa của người duyệt được kiểm tra lại trước khi xóa; vẫn chờ đủ 24 giờ sau lượt duyệt cuối. Đề nghị cũ có hai lượt duyệt cùng vai trò sẽ bị chặn, không được tự chuyển thành đủ điều kiện theo chính sách mới.
- Một hồ sơ đang hoạt động được claim bằng `documents.destruction_request_id`, với khóa dòng khi lập đề nghị. Rejected/withdrawn giải phóng claim; failed giữ claim và tiến độ.
- Migration thêm FK RESTRICT và trigger bảo vệ chứng từ, snapshot, approval, idempotency và log hủy. Không xóa dòng `documents`, không xóa phiên bản/audit để thay thế cho xóa bytes.
- Worker chỉ được xóa vùng nội dung: local provider tách root nội dung khỏi bảng chứng từ/journal; gateway dùng tài khoản riêng không được quyền xóa/ghi chứng từ. Tài khoản app DB không có DROP/ALTER/TRIGGER trong vận hành; dùng tài khoản migration riêng để cài schema.

## Chứng từ

Bytes PDF được lưu tại bảng riêng `destruction_attachment_content` trong **cùng transaction** với metadata chứng từ, đề nghị, items, audit và kết quả idempotency. Upload lỗi rollback toàn bộ, không có object tạm bỏ quên hoặc đề nghị pending thiếu quyết định. Bảng này có trigger cấm update/delete, FK RESTRICT, cột bytes không được chọn mặc định.

Tên chứng từ mới được chuẩn hóa UTF-8 trước khi lưu, giữ dấu tiếng Việt và dấu câu hợp lệ, loại bỏ thành phần đường dẫn/ký tự điều khiển. JSON chi tiết trả `filename` và alias `originalFilename` cùng tên đã lưu; header PDF có `filename*` UTF-8 và tên ASCII dự phòng lấy từ tên tệp. Không tự đặt tên theo loại chứng từ. Không sửa hàng loạt tên chứng từ cũ đã bất biến; tên đã mất ký tự do lần lưu trước cần đối chiếu với nguồn gốc, không thể suy ra chính xác từ tên bị hỏng.

PDF được parse bằng pdf-lib, từ chối mã hóa/không đọc được/trống, rồi yêu cầu scanner hạ tầng xác nhận `clean` và `readable`. SHA-256 tính từ bytes thực. Chữ ký số luôn là `not_checked`; xác nhận có chữ ký tay và OTP không biến thành kết quả xác minh chữ ký số.

Giới hạn mỗi PDF 25 MiB. Đặt `max_allowed_packet` MySQL ít nhất 64 MiB, giới hạn body reverse proxy phù hợp hai PDF/multipart và gateway scanner phù hợp payload base64. Chứng từ/backup DB chứa chứng từ phải ở vùng được bảo vệ riêng, không nằm trong manifest nội dung cần hủy. SQL query logging được tắt để không ghi bytes vào log.

API tải chứng từ chỉ nhận Bearer JWT phiên thường, kiểm tra attachment thuộc request, quyền xem, độ dài và checksum trước khi trả bytes; không dùng query token hoặc file-download token. Không trả object key. Nội dung và JSON nhạy cảm có `Cache-Control: no-store`.

## Retention và legal hold

`expires_at` cũ có thể đã được tính từ ngày upload nên **không được backfill sang retention_until**. Migration để retention_until NULL. Dữ liệu cũ chỉ được điền sau khi đơn vị xác nhận mốc/thời hạn bảo quản.

Tính retention_until cho hồ sơ có loại và thời hạn xác định, ngày mốc `document_date`/`patient_death_date` và đã duyệt; dùng UTC, cuối ngày đến hạn. Thiếu mốc không đủ điều kiện hủy, dù expires_at cũ đã qua hạn. Hồ sơ vĩnh viễn/chưa phân loại không được hủy.

Cho phép tìm, lập đề nghị, duyệt và thực hiện hủy trước ngày `retention_until` theo quyết định có chữ ký đính kèm. Không bắt buộc hồ sơ đã hết hạn lưu trữ. Vẫn phải có metadata thời hạn hợp lệ, đủ lượt duyệt OTP bởi Admin khác người lập và chờ đủ 24 giờ sau lượt duyệt cuối. Legal hold, quyền truy cập, claim của đề nghị khác, kiểm kê nội dung và bảo vệ backup vẫn được kiểm tra như cũ; không có endpoint xóa ngay.

Nếu lập đề nghị bị từ chối, lỗi `INELIGIBLE_DOCUMENT` nêu hồ sơ và các điều kiện còn thiếu. Kiểm tra trực tiếp trên server bằng `node scripts/check-destruction.cjs --document <document-uuid>` sau khi build: lệnh chỉ đọc metadata, không sửa hồ sơ, không khởi tạo journal, không gửi OTP và không xóa file. Kết quả này không thay thế kiểm tra quyền, hạ tầng hoặc chứng từ khi gửi đề nghị.

`PATCH /retention/documents/:id/legal-hold` chỉ Admin, body `{ "legalHold": true }` hoặc false. Khóa dòng tài liệu, ghi audit; trả 409 khi worker đã chiếm quyền hủy hoặc tài liệu đã destroyed. Không có thao tác bỏ legal hold trong form hủy.

Điều kiện được kiểm tra khi tạo, từng lượt duyệt, worker nhận job và trước mỗi lần gọi xóa. Mọi thay đổi policy loại hồ sơ/snapshot/độ mật/hash/version làm công việc dừng an toàn. Trigger khóa sửa nội dung/phiên bản/retention của hồ sơ đang có claim, ngăn tái sử dụng file đang được hủy và cấm đổi legal hold sau khi worker bắt đầu.

## API

| Method | Đường dẫn | Nội dung |
| --- | --- | --- |
| GET | /destruction/capabilities | enabled/canCreate boolean, giờ DB UTC mới, giới hạn, policy đủ ba đích |
| GET | /destruction/eligible-documents | q, page, pageSize; lọc quyền và điều kiện trước phân trang |
| POST | /destruction/requests | multipart theo hợp đồng frontend |
| GET | /destruction/requests | status, page, pageSize |
| GET | /destruction/requests/:id | snapshot, approvals, chứng từ, events, trạng thái backup, allowedActions |
| GET | /destruction/requests/:id/attachments/:attachmentId/content | PDF đã kiểm checksum |
| POST | /destruction/requests/:id/otp-challenges | If-Match, purpose approve |
| POST | /destruction/requests/:id/approve | If-Match, Idempotency-Key, OTP và documentsReviewed |
| POST | /destruction/requests/:id/reject | If-Match, Idempotency-Key, reason |
| POST | /destruction/requests/:id/withdraw | If-Match, Idempotency-Key, reason |
| POST | /destruction/requests/:id/complete | multipart biên bản hủy, If-Match, Idempotency-Key |
| GET | /destruction/destroyed-documents | Chỉ metadata đã xác nhận destroyed |

If-Match phải ở dạng `"<version>"`. Idempotency gắn actor + endpoint + key + digest canonical; replay thành công được đọc trước version và kiểm tra hạ tầng. Không lưu OTP thô hoặc cache kết quả OTP sai. Mỗi actor bị serialize khi mutation để chống trùng key đồng thời; deadlock/lock timeout/unique conflict được trả 409 để gửi lại cùng key.

OTP 6 số, sống 5 phút, tối đa 5 lần thử/challenge, cách lần cấp ít nhất 60 giây, tối đa 10 lần/giờ/tài khoản. OTP gửi tới kênh đăng ký ở gateway, API không nhận địa chỉ đích từ client. Chỉ lưu HMAC, không log OTP. Challenge gắn actor/request/purpose/version/digest. Lượt duyệt và consume OTP cùng transaction. Đếm lần sai được commit nhưng không ghi replay thành công.

Lượt duyệt cuối tạo job và execute_after = giờ DB + đúng 24 giờ trong transaction. Chưa đủ hai lượt thì execute_after NULL và không có job. Thu hồi scheduled chỉ trước execute_after và cùng khóa request với worker. Không có endpoint xóa ngay/retry tùy ý cho frontend.

Đề nghị đã lên lịch trước khi đổi thời gian chờ giữ nguyên lịch đã lưu. Để chuyển riêng một đề nghị đang chờ từ 48 sang 24 giờ, chạy `node scripts/reschedule-destruction.cjs <request-uuid>` để xem lịch dự kiến, rồi thêm `--apply` để cập nhật. Lệnh tính từ lượt duyệt cuối, kiểm tra lại hồ sơ/quyền duyệt, khóa request/job cùng thứ tự với worker, cập nhật cả `execute_after` và `run_at`, tăng version và ghi audit. Không sửa đề nghị đã bắt đầu hủy. Nếu mốc mới đã qua, worker có thể nhận việc ngay sau cập nhật.

## Gateway hạ tầng tùy chọn

Phần này chỉ áp dụng khi chọn `DESTRUCTION_PROVIDER=gateway`. Với triển khai local, dùng [hướng dẫn tích hợp trực tiếp](destruction-local.md).

Cấu hình:

```dotenv
DESTRUCTION_ENABLED=false
DESTRUCTION_PROVIDER=gateway
DESTRUCTION_GATEWAY_URL=https://gateway-noi-bo.example/destruction
DESTRUCTION_GATEWAY_SECRET=<bi-mat-ngau-nhien-it-nhat-32-ky-tu>
DESTRUCTION_BACKUP_STAGING_ROOT=<thu-muc-snapshot-backup-duoc-bao-ve>
CORS_ORIGINS=https://frontend.example
DB_SYNCHRONIZE=false
```

Mọi thao tác gateway là POST JSON với Authorization Bearer secret, timeout 30 giây; cấm redirect. Dùng HTTPS; HTTP chỉ cho loopback. Gateway phải giới hạn IP/tài khoản, không log body OTP/PDF/secret, không nhận đường dẫn từ browser. Không public gateway ra frontend.

| Gateway path | Request/response bắt buộc |
| --- | --- |
| health | Nhận `{}`. Trả tất cả các cờ `ready`, `otp`, `worker`, `immutableEvidence`, `malwareScanner`, `contentInventory`, `backupExclusion`, `restoreTombstones` bằng boolean true, cùng `backupPolicy` có version và đúng ba targets external/cloud/nas. Mỗi target có label, purgeWithinDays là số nguyên dương và notes. Đây phải là kiểm tra tích hợp thật, không phải trả cấu hình tĩnh để bật giao diện. |
| scan-pdf | Nhận bytes base64. Trả `{clean:true,readable:true}` chỉ sau scanner và kiểm tra nội dung thành công. |
| otp/deliver | Nhận actorId, challengeId, otp, expiresAt. Tra kênh đã đăng ký của actor từ nguồn tin cậy; trả `{delivered:true}` chỉ sau khi gửi thành công. Không log body. |
| content/inventory | Nhận requestId, documentId, snapshot, currentStorageKey, versions từ DB. Trả manifest gồm id, documentId, primaryChecksum, contentVersion, complete/safe/exclusiveOwnership true và objects `[{key,sha256,...}]`. Lưu manifest bất biến và hash thực ở gateway. |
| backup/exclude | Nhận operationId, requestId, documentId, target, objects, backupPolicy. Commit tombstone/exclusion bền vững, độc lập DB có thể bị restore, cho mọi object/version trước backup mới. Trả excluded/restoreProtected true và evidenceId. Không coi đây là đã purge bản cũ. |
| content/destroy | Nhận operationId, requestId, documentId, manifestId, manifestDigest. Chỉ xử lý manifest tin cậy đã lưu. Trả cùng operationId/manifestId, primaryChecksum, evidenceId, verifiedAbsent true và đủ objects `[{key,sha256,verifiedAbsent:true,evidenceId}]` sau khi xác minh toàn bộ bytes đã xóa. |
| backup/purge | Nhận operationId, requestId, documentId, target, objects, purgeDueAt. Trả verifiedAbsent true + evidenceId chỉ khi hết mọi bản sao/version/snapshot thuộc manifest; bản immutable chưa đến hạn trả verifiedAbsent false. Backend tiếp tục retry và báo quá hạn, kể cả request completed. |
| backup/begin | Nhận operationId. Tạo snapshot ổn định đã áp tombstone, trả sessionId, maintenanceProtected/exclusionsApplied/snapshotStable true và sourceDirectory trong thư mục con của DESTRUCTION_BACKUP_STAGING_ROOT. Snapshot không có symlink và không thay đổi trước khi đóng session. |
| backup/end | Nhận sessionId, success. Đóng phiên, trả closed true. Fail không được ghi bằng chứng backup thành công. |
| restore/begin | Nhận operationId. Đặt hệ thống/reverse proxy ở chế độ bảo trì, phối hợp worker/backup để không phục vụ dữ liệu đang restore. Trả sessionId, maintenanceProtected true sau khi khóa đã có hiệu lực. |
| restore/apply-tombstones | Nhận sessionId. Sau restore, áp lại tombstone từ kho độc lập vào DB và mọi object/version/index/cache trước khi công bố. Trả applied/verified true và evidenceId sau kiểm tra thật. |
| restore/end | Nhận sessionId, success true sau khi xác nhận tombstone. Công bố dữ liệu, trả closed true. Khi restore/apply thất bại phải giữ bảo trì, không tự hết hạn để mở lại dữ liệu. |

Gateway content/inventory/destroy phải thực hiện đầy đủ:

1. Resolve realpath với root SAN cấu hình; cấm traversal, symlink/junction thoát root và TOCTOU đổi đường dẫn sau kiểm tra. Không xóa cả directory hoặc nhận wildcard từ client.
2. Kiểm kê file chính, mọi version và các bản OCR/preview/thumbnail/index/cache có nội dung. Chỉ bật `contentInventory` nếu đã nối đủ các kho thực tế. Chứng từ/backup chứng từ nằm ngoài SAN root cần hủy.
3. Kiểm tra tham chiếu của documents, document_versions, personal_files và mọi kho dedup khác; từ chối xóa object còn được hồ sơ khác sử dụng. Không suy ra sở hữu chỉ từ filename/hash. Quyền sở hữu phải được khóa hoặc fence đến khi xóa xong.
4. Tính lại checksum/version ngay trước từng lần xóa. Hash đổi hoặc file mất khi chưa có WAL/receipt hợp lệ phải dừng, không báo thành công.
5. Ghi WAL/intent và checkpoint cho từng object trước xóa; fsync/commit bền vững. Cùng operationId phải trả lại receipt cũ sau crash/mất response, không xóa lại mù quáng. Nhiều worker gọi cùng operationId phải được serialize/fence ở gateway.
6. Khi xóa một phần rồi lỗi, giữ receipts của phần đã xóa. Retry tiếp tục manifest đã duyệt; không inventory lại để bỏ qua object đã mất. Không có thao tác khôi phục file đã xóa.
7. Ba đích backup có object/version key, evidence và trách nhiệm xử lý riêng. Gateway phải phát cảnh báo vận hành cho lỗi/ngoại lệ immutable và bảo vệ chứng từ độc lập.

Worker Nest chạy mỗi 30 giây khi ứng dụng ở server đang hoạt động; không phụ thuộc browser. Job ở DB, lease 120 giây, heartbeat mỗi 20 giây và gia hạn ở checkpoint; khi process chết, worker khác có thể nhận lease hết hạn. Manifest/operationId được ghi trước khi gọi xóa. Sau lỗi cần kiểm tra vận hành; không tự retry một request failed.

## Backup và restore hiện có

`backup.js`, `data-pipeline.js backup-sync` và `/system/backup` đều dùng barrier chung. Khi có cấu hình gateway hoặc bất kỳ lịch sử đề nghị hủy, không còn fallback sao chép thô khi gateway lỗi; chỉ copy snapshot đã áp exclusions. Chưa cấu hình gateway và chưa có đề nghị thì giữ luồng cũ. Bản dump DB/chứng từ phải được quản lý trong vùng backup bảo vệ riêng.

`data-pipeline.js import-mysql-dump` lấy maintenance barrier trước khi import, gọi apply-tombstones trước đóng barrier. Nếu import hoặc xác nhận tombstone lỗi, giữ maintenance để vận hành xử lý. Các công cụ restore ngoài repository cũng phải tuân theo cùng quy trình; không dùng mysqldump/mysql thủ công vào DB đang phục vụ để bỏ qua barrier.

Không xóa lịch sử/tombstone để bật lại backup cũ. Barrier bảo vệ snapshot phải bền vững suốt tác vụ copy dài; gateway không được tự giải phóng snapshot khi script vẫn dùng nó.

## Triển khai và vận hành

1. Sao lưu DB; thử trên DB staging riêng. `DB_SYNCHRONIZE=false`, app dừng trong lúc cài schema. MySQL DDL có implicit commit; migration có thể tiếp tục khi chạy lại nếu bị dừng giữa chừng, nhưng phải xem lỗi/schema trước khi chạy lại.
2. `npm run build`, sau đó **chỉ vận hành** chạy `npm run db:add-destruction`. Migration không tự chạy lúc app khởi động và không backfill hạn từ upload. Giữ nguyên enum status cũ, thêm destroyed.
3. Cài DB grants/trigger và packet size; kiểm tra schema legacy có UUID varchar(36). Migration giữ collation của FK tương ứng, không drop dữ liệu. Không tự rollback/drop chứng từ; rollback code vẫn giữ schema.
4. Chọn local theo runbook hoặc gateway theo bảng trên; cấu hình chính sách backup thực, kênh OTP, scanner, SAN và các snapshot/version cloud/NAS. Chưa có đủ tích hợp thật thì giữ enabled=false.
5. Nghiệm thu các lỗi/race trên staging, gồm nhiều process, legal hold/withdraw sát giờ, mất response, crash giữa xóa và checkpoint, symlink/dedup/hash đổi, backup/restore và chứng từ bất biến.
6. Sau nghiệm thu mới bật DESTRUCTION_ENABLED=true; kiểm tra capabilities, quyền Admin nhạy cảm và giám sát worker/purge quá hạn.

Retry sau khi chẩn đoán và xử lý nguyên nhân:

```powershell
node scripts/retry-destruction.cjs --request <request-uuid> --actor <admin-uuid> --reason "Đã xử lý nguyên nhân, đối chiếu receipts" --apply
```

Lệnh chỉ requeue cặp request/job failed, tăng version và ghi audit. Không reset checkpoint/approval/OTP, execute_after, items đã destroyed hoặc tombstone. Worker vẫn kiểm tra lại quyền người duyệt/chính sách/điều kiện. Legal hold sau khi đã bắt đầu hủy không thể được báo là bật thành công.

## Kiểm thử

```powershell
npm run test:destruction
node scripts/test-document-security.cjs
node scripts/test-document-review-permissions.cjs
```

Test hủy dùng DB transaction mô phỏng và gateway giả trong process; kiểm tra rollback, idempotency, OTP sai/replay/khác actor/khác version, hai người duyệt, worker/checkpoint, backup sau completed, chặn đọc nội dung, retention và metadata migration. Không kết nối DB/SAN/SMTP thật. Bộ security có kiểm tra SQL scope qua SQLite in-memory.

Các test này **không chứng minh** DDL, row-lock/deadlock MySQL thực, ACL SAN, scanner, gửi OTP, version cloud, object-lock hoặc restore hoạt động ở môi trường triển khai. Đây là các điều kiện nghiệm thu bắt buộc trước khi bật dịch vụ.
