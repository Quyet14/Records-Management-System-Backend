import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  Document,
  DocumentStatus,
  ClassificationValue,
  ReviewStatus,
  DocumentVisibility,
} from '../entities/document.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { User, UserRole } from '../entities/user.entity';
import { DocumentComment } from '../entities/document-comment.entity';
import { StoredFile } from '../entities/stored-file.entity';
import { AccessLog, AccessLogAction } from '../entities/access-log.entity';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { SearchDocumentDto } from './dto/review-document.dto';
import { RetentionService } from '../retention/retention.service';
import { JwtService } from '@nestjs/jwt';

interface AuthUser {
  id: string;
  role: UserRole;
  departmentId?: string;
  fileId?: string;
  tokenType?: string;
}

@Injectable()
export class DocumentsService {
  private archiveDir =
    process.env.UPLOAD_ARCHIVE_DIR || './storage/archive';

  constructor(
    @InjectRepository(Document) private docsRepo: Repository<Document>,
    @InjectRepository(StoredFile) private filesRepo: Repository<StoredFile>,
    @InjectRepository(AuditLog) private auditRepo: Repository<AuditLog>,
    @InjectRepository(AccessLog) private accessLogsRepo: Repository<AccessLog>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(DocumentComment) private commentRepo: Repository<DocumentComment>,
    private eventEmitter: EventEmitter2,
    private retentionService: RetentionService,
    private jwtService: JwtService,
  ) {
    if (!fs.existsSync(this.archiveDir)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
  }

  // ─── Bước 2: Tạo đường dẫn lưu trữ theo năm/ngày ──────────
  private buildArchiveLocation(docId: string, ext: string): {
    dirPath: string;
    dateStr: string;
    filePath: string;
  } {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const dd   = String(now.getDate()).padStart(2, '0');
    const HH   = String(now.getHours()).padStart(2, '0');
    const Min  = String(now.getMinutes()).padStart(2, '0');
    const SS   = String(now.getSeconds()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    // Cấu trúc: {archiveDir}/{YYYY}/{YYYY-MM-DD}/
    const dirPath = path.join(this.archiveDir, yyyy, dateStr);

    // Tên file: HHmmss-<docId>.pdf — dễ sort theo giờ, unique theo docId
    const fileName = `${HH}${Min}${SS}-${docId}${ext}`;
    const filePath = path.join(dirPath, fileName);

    return { dirPath, dateStr, filePath };
  }

  private buildContentAddressedLocation(
    departmentId: string | undefined,
    fileHash: string,
  ): string {
    const year = new Date().getFullYear().toString();
    const scope = departmentId || 'shared';
    return path.join(this.archiveDir, scope, year, `${fileHash}.pdf`);
  }

  private async storePhysicalFile(
    file: Express.Multer.File,
    departmentId: string | undefined,
  ): Promise<StoredFile> {
    const fileHash = await this.computeChecksum(file.path);
    const existing = await this.filesRepo.findOne({ where: { fileHash } });

    if (existing) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return existing;
    }

    const storageKey = this.buildContentAddressedLocation(departmentId, fileHash);
    await this.withRetry(() => fs.mkdirSync(path.dirname(storageKey), { recursive: true }));
    await this.withRetry(() => fs.renameSync(file.path, storageKey));

    return this.filesRepo.save(this.filesRepo.create({
      fileHash,
      storageKey,
      size: file.size,
      mimeType: file.mimetype || 'application/pdf',
    }));
  }

  // ─── Bước 4: Ghi log ngày dạng TSV — chiếm dung lượng nhỏ nhất ─
  private appendDayLog(
    dirPath: string,
    dateStr: string,
    fields: {
      action: string;
      uploaderEmail: string;
      approverEmail: string;
      docId: string;
      fileName: string;
      fileSizeBytes: number;
    },
  ): void {
    try {
      const logFile = path.join(dirPath, `${dateStr}.log`);
      const now     = new Date().toISOString();
      // Tab-separated: timestamp | action | uploader | approver | docId | fileName | size(bytes)
      const line    = [
        now,
        fields.action,
        fields.uploaderEmail,
        fields.approverEmail,
        fields.docId,
        fields.fileName,
        fields.fileSizeBytes,
      ].join('\t') + '\n';
      fs.appendFileSync(logFile, line, 'utf8');
    } catch {
      // Lỗi ghi log phụ không làm hỏng luồng chính
    }
  }

  // ─── Bước 5: Retry cho thao tác ghi lên SAN/NFS ─────────────
  private async withRetry<T>(
    fn: () => T,
    retries = 3,
    delayMs = 500,
  ): Promise<T> {
    let lastErr: Error | undefined;
    for (let i = 0; i < retries; i++) {
      try {
        return fn();
      } catch (err) {
        lastErr = err as Error;
        if (i < retries - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    throw lastErr;
  }

  // ─── UPLOAD NHIỀU FILE ────────────────────────────────────────
  // Mỗi file xử lý độc lập — file lỗi không chặn file còn lại.
  async uploadMultiple(
    files: Express.Multer.File[],
    departmentId: string | undefined,
    user: AuthUser,
  ): Promise<{ success: Document[]; failed: { filename: string; error: string }[] }> {
    const success: Document[] = [];
    const failed: { filename: string; error: string }[] = [];

    for (const file of files) {
      try {
        const storedFile = await this.storePhysicalFile(file, departmentId);
        const doc = this.docsRepo.create({
          originalFilename: file.originalname,
          // Dùng tên file (không có extension) làm title mặc định
          title: file.originalname.replace(/\.[^/.]+$/, ''),
          department: departmentId ? ({ id: departmentId } as any) : null,
          uploader: { id: user.id } as any,
          status: DocumentStatus.PENDING,
          storagePath: storedFile.storageKey,
          fileSizeBytes: file.size,
          sha256Checksum: storedFile.fileHash,
          file: storedFile,
        });
        const saved = await this.docsRepo.save(doc);
        await this.log(user.id, 'upload', saved.id, { filename: file.originalname });
        this.eventEmitter.emit('document.uploaded', {
          documentId: saved.id,
          documentTitle: saved.title || saved.originalFilename,
          uploaderId: user.id,
          departmentId: departmentId ?? null,
        });
        success.push(saved);
      } catch (err) {
        // Xóa file staging nếu DB save thất bại
        if (fs.existsSync(file.path)) {
          try { fs.unlinkSync(file.path); } catch (_) {}
        }
        failed.push({ filename: file.originalname, error: (err as Error).message });
      }
    }

    return { success, failed };
  }

  // ─── UPLOAD ────────────────────────────────────────────────
  async upload(
    file: Express.Multer.File,
    dto: UploadDocumentDto,
    user: AuthUser,
  ): Promise<Document> {
    const visibility = dto.visibility ?? DocumentVisibility.DEPARTMENT;
    console.log(`[upload] visibility received: "${dto.visibility}" → using: "${visibility}"`);

    // Auto-approve nếu: visibility=private HOẶC frontend gửi autoApprove=true
    const shouldAutoApprove =
      visibility === DocumentVisibility.PRIVATE ||
      dto.autoApprove === true ||
      String(dto.autoApprove) === 'true'; // multipart gửi string

    /**
     * Xử lý theo visibility:
     * - public / department → PENDING, chờ Admin duyệt
     * - private             → STORED ngay, lưu thẳng vào archive (không cần duyệt)
     */
    if (shouldAutoApprove) {
      const storedFile = await this.storePhysicalFile(file, dto.departmentId);
      const archivePath = storedFile.storageKey;
      const dirPath = path.dirname(archivePath);
      const dateStr = new Date().toISOString().slice(0, 10);

      const doc = this.docsRepo.create({
        originalFilename: file.originalname,
        title:            dto.title,
        summary:          dto.summary,
        referenceNo:      dto.referenceNo,
        issuingUnit:      dto.issuingUnit,
        organizingBody:   dto.organizingBody,
        receivedDate:     dto.receivedDate ? new Date(dto.receivedDate) : undefined,
        documentNumber:   dto.documentNumber,
        securityLevel:    dto.securityLevel,
        authorName:       dto.authorName,
        description:      dto.description,
        department:       dto.departmentId ? ({ id: dto.departmentId } as any) : null,
        uploader:         { id: user.id } as any,
        status:           DocumentStatus.STORED,
        storagePath:      archivePath,
        fileSizeBytes:    file.size,
        sha256Checksum:   storedFile.fileHash,
        file:             storedFile,
        approvedAt:       new Date(),
        approvedBy:       { id: user.id } as any,
        visibility,
        documentType:       dto.documentTypeId ? ({ id: dto.documentTypeId } as any) : undefined,
        documentDate:       dto.documentDate ? new Date(dto.documentDate) : undefined,
        classificationValue: dto.classificationValue ?? ClassificationValue.UNCLASSIFIED,
      });
      const saved = await this.docsRepo.save(doc);

      this.appendDayLog(dirPath, dateStr, {
        action:        'auto-approve (private)',
        uploaderEmail: user.id,
        approverEmail: user.id,
        docId:         saved.id,
        fileName:      file.originalname,
        fileSizeBytes: file.size ?? 0,
      });

      await this.log(user.id, 'upload_private', saved.id, { filename: file.originalname });
      return saved;
    }

    const storedFile = await this.storePhysicalFile(file, dto.departmentId);

    // public hoặc department → PENDING như bình thường
    const doc = this.docsRepo.create({
      originalFilename: file.originalname,
      title:            dto.title,
      summary:          dto.summary,
      referenceNo:      dto.referenceNo,
      issuingUnit:      dto.issuingUnit,
      organizingBody:   dto.organizingBody,
      receivedDate:     dto.receivedDate ? new Date(dto.receivedDate) : undefined,
      documentNumber:   dto.documentNumber,
      securityLevel:    dto.securityLevel,
      authorName:       dto.authorName,
      description:      dto.description,
      department:       dto.departmentId ? ({ id: dto.departmentId } as any) : null,
      uploader:         { id: user.id } as any,
      status:           DocumentStatus.PENDING,
      storagePath:      storedFile.storageKey,
      fileSizeBytes:    file.size,
      sha256Checksum:   storedFile.fileHash,
      file:             storedFile,
      visibility,
      documentType:       dto.documentTypeId ? ({ id: dto.documentTypeId } as any) : undefined,
      documentDate:       dto.documentDate ? new Date(dto.documentDate) : undefined,
      classificationValue: dto.classificationValue ?? ClassificationValue.UNCLASSIFIED,
    });
    const saved = await this.docsRepo.save(doc);

    await this.log(user.id, 'upload', saved.id, { filename: file.originalname });

    // Emit event để admin/trưởng khoa nhận realtime qua SSE
    this.eventEmitter.emit('document.uploaded', {
      documentId:    saved.id,
      documentTitle: saved.title || saved.originalFilename,
      uploaderId:    user.id,
      departmentId:  dto.departmentId ?? null,
    });

    return saved;
  }

  // ─── DUYỆT (Admin hoặc Trưởng Khoa trong khoa mình) ──────────
  async approve(id: string, actor: AuthUser): Promise<Document> {
    const doc = await this.getOrFail(id);
    if (doc.status !== DocumentStatus.PENDING) {
      throw new ForbiddenException('Tài liệu này đã được xử lý trước đó');
    }

    // Trưởng khoa chỉ được duyệt tài liệu trong khoa mình
    if (actor.role === UserRole.DEPARTMENT_HEAD) {
      if (!doc.department) {
        throw new ForbiddenException(
          'Tài liệu không thuộc khoa nào, chỉ Admin mới duyệt được',
        );
      }
      if (doc.department.id !== actor.departmentId) {
        throw new ForbiddenException(
          'Bạn chỉ có thể duyệt tài liệu trong khoa mình',
        );
      }
    }

    let checksum = doc.sha256Checksum;
    let archivePath = doc.file?.storageKey || doc.storagePath;
    let dirPath = path.dirname(archivePath);
    const dateStr = new Date().toISOString().slice(0, 10);

    if (!doc.file) {
      checksum = checksum || await this.computeChecksum(doc.storagePath);
      archivePath = this.buildContentAddressedLocation(doc.department?.id, checksum);
      dirPath = path.dirname(archivePath);
      await this.withRetry(() => fs.mkdirSync(dirPath, { recursive: true }));
      await this.withRetry(() => fs.renameSync(doc.storagePath, archivePath));
      doc.file = await this.filesRepo.save(this.filesRepo.create({
        fileHash: checksum,
        storageKey: archivePath,
        size: doc.fileSizeBytes ?? 0,
        mimeType: 'application/pdf',
      }));
    }

    // Bước 3d: Cập nhật DB
    doc.status        = DocumentStatus.STORED;
    doc.storagePath   = archivePath;
    doc.sha256Checksum = checksum;
    doc.approvedAt    = new Date();
    doc.approvedBy    = { id: actor.id } as any;
    const saved = await this.docsRepo.save(doc);

    // Tính hạn lưu trữ tự động
    const docWithType = await this.docsRepo.findOne({
      where: { id: doc.id },
      relations: ['documentType'],
    });
    if (docWithType) {
      await this.retentionService.computeAndSaveExpiry(docWithType);
    }

    // Bước 4: Ghi log ngày dạng TSV
    const approverUser = await this.userRepo.findOne({
      where: { id: actor.id },
      select: ['email'],
    });
    this.appendDayLog(dirPath, dateStr, {
      action:        'approve',
      uploaderEmail: (doc.uploader as any)?.email ?? actor.id,
      approverEmail: approverUser?.email ?? actor.id,
      docId:         doc.id,
      fileName:      doc.originalFilename,
      fileSizeBytes: doc.fileSizeBytes ?? 0,
    });

    await this.log(actor.id, 'approve', doc.id, { archivePath });

    // TODO (Giai đoạn 4): đẩy job OCR + index vào Meilisearch tại đây

    // Emit event thông báo cho người upload
    this.eventEmitter.emit('document.approved', {
      documentId:    doc.id,
      documentTitle: saved.title || saved.originalFilename,
      uploaderId:    (doc.uploader as any)?.id ?? '',
      uploaderEmail: (doc.uploader as any)?.email ?? '',
      uploaderName:  (doc.uploader as any)?.fullName ?? '',
      actorName:     actor.id,
    });

    return saved;
  }

  async reject(id: string, actor: AuthUser, reason: string): Promise<Document> {
    const doc = await this.getOrFail(id);
    if (doc.status !== DocumentStatus.PENDING) {
      throw new ForbiddenException('Tài liệu này đã được xử lý trước đó');
    }

    // Trưởng khoa chỉ được từ chối tài liệu trong khoa mình
    if (actor.role === UserRole.DEPARTMENT_HEAD) {
      if (!doc.department) {
        throw new ForbiddenException(
          'Tài liệu không thuộc khoa nào, chỉ Admin mới xử lý được',
        );
      }
      if (doc.department.id !== actor.departmentId) {
        throw new ForbiddenException(
          'Bạn chỉ có thể từ chối tài liệu trong khoa mình',
        );
      }
    }

    // File mới dùng chung trong bảng files, không xóa khi một document bị từ chối.
    if (!doc.file && fs.existsSync(doc.storagePath)) {
      fs.unlinkSync(doc.storagePath);
    }

    doc.status = DocumentStatus.REJECTED;
    doc.rejectReason = reason;
    const saved = await this.docsRepo.save(doc);

    await this.log(actor.id, 'reject', doc.id, { reason });

    // Emit event để gửi thông báo cho người upload
    this.eventEmitter.emit('document.rejected', {
      documentId: doc.id,
      documentTitle: saved.title || saved.originalFilename,
      uploaderId: (doc.uploader as any)?.id ?? '',
      uploaderEmail: (doc.uploader as any)?.email ?? '',
      uploaderName: (doc.uploader as any)?.fullName ?? '',
      actorName: actor.id,
      rejectReason: reason,
    });

    return saved;
  }

  // ─── HÀNG CHỜ DUYỆT (Admin: toàn hệ thống, Trưởng Khoa: khoa mình) ──────
  async findPendingQueue(user?: AuthUser, query?: { page?: number; limit?: number }) {
    const qb = this.docsRepo
      .createQueryBuilder('doc')
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.approvedBy', 'approvedBy')
      .leftJoinAndSelect('doc.documentType', 'documentType')
      .where('doc.status = :status', { status: DocumentStatus.PENDING });

    // Trưởng khoa chỉ thấy tài liệu của khoa mình
    if (user?.role === UserRole.DEPARTMENT_HEAD && user?.departmentId) {
      qb.andWhere('department.id = :deptId', { deptId: user.departmentId });
    }

    qb.orderBy('doc.createdAt', 'ASC');

    const page = query?.page ?? 1;
    const limit = query?.limit ?? 20;
    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  // ─── KHO LƯU TRỮ CÁ NHÂN (tài liệu private của user) ────────
  async getMyStorage(user: AuthUser, query: { page: number; limit: number }) {
    const qb = this.docsRepo
      .createQueryBuilder('doc')
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.documentType', 'documentType')
      .leftJoinAndSelect('doc.file', 'file')
      .where('doc.uploader_id = :userId', { userId: user.id })
      .andWhere('doc.visibility = :visibility', { visibility: DocumentVisibility.PRIVATE })
      .orderBy('doc.createdAt', 'DESC');

    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;
    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();

    // ĐÃ SỬA: bỏ fs.existsSync() đồng bộ trong vòng lặp — đây là nguyên nhân
    // chính gây nghẽn event loop và rò rỉ RAM khi tải cao (2000 VU).
    // fs.existsSync() là hàm ĐỒNG BỘ, chặn toàn bộ event loop của Node.js
    // trong lúc chờ I/O đĩa. Với 2000 request đồng thời x 20 record/trang,
    // event loop bị khóa liên tục → request xếp hàng → RAM phình to → PM2 kill.
    //
    // fileExists giờ không cần kiểm tra ở API danh sách nữa — chỉ kiểm tra
    // khi user thực sự bấm xem/tải file (đã có sẵn trong getFileForDownload()).
    return { data, total, page, limit };
  }

  // ─── TÌM KIẾM (điểm mấu chốt phân quyền) ──────────────────
  // Admin: thấy toàn bộ, có thể lọc theo khoa.
  // Public đã lưu trữ/duyệt: mọi tài khoản đăng nhập đều thấy.
  // Department: chỉ cùng khoa; private: chỉ uploader (Admin thấy toàn bộ).
  async search(query: SearchDocumentDto, user: AuthUser) {
    const qb = this.docsRepo
      .createQueryBuilder('doc')
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.approvedBy', 'approvedBy')
      .leftJoinAndSelect('doc.documentType', 'documentType')
      .leftJoinAndSelect('doc.file', 'file')
      // ĐÃ SỬA: giới hạn field trả về cho danh sách, bỏ description (text OCR
      // dài) khỏi response — giảm đáng kể kích thước payload phải serialize
      // và truyền qua mạng khi có nhiều request đồng thời. Cần xem đầy đủ
      // description thì gọi API chi tiết GET /documents/:id.
      .select([
        'doc.id',
        'doc.originalFilename',
        'doc.title',
        'doc.status',
        'doc.rejectReason',
        'doc.classificationValue',
        'doc.reviewStatus',
        'doc.visibility',
        'doc.fileSizeBytes',
        'doc.sha256Checksum',
        'doc.documentDate',
        'doc.expiresAt',
        'doc.patientDeathDate',
        'doc.createdAt',
        'doc.approvedAt',
        'doc.storagePath',
        'uploader.id',
        'uploader.fullName',
        'uploader.email',
        'department.id',
        'department.name',
        'approvedBy.id',
        'approvedBy.fullName',
        'approvedBy.email',
        'documentType.id',
        'documentType.code',
        'documentType.name',
        'documentType.isPermanent',
        'file.id',
        'file.storageKey',
        'file.mimeType',
        'file.size',
      ]);

    if (user.role === UserRole.ADMIN) {
      if (query.departmentId) {
        qb.andWhere('department.id = :departmentId', {
          departmentId: query.departmentId,
        });
      }
    } else {
      // Public đã lưu trữ/duyệt được xem trên toàn hệ thống, không phụ thuộc khoa.
      const publicStoredOrApproved =
        '(doc.visibility = :public AND doc.status IN (:...publicStatuses))';

      if (user.departmentId) {
        qb.andWhere(
          `(
            ${publicStoredOrApproved}
            OR (doc.visibility = :dept AND department.id = :userDeptId)
            OR (doc.visibility = :priv AND uploader.id = :uploaderId)
          )`,
          {
            public:          DocumentVisibility.PUBLIC,
            publicStatuses: [DocumentStatus.STORED, DocumentStatus.APPROVED],
            dept:            DocumentVisibility.DEPARTMENT,
            priv:            DocumentVisibility.PRIVATE,
            userDeptId:      user.departmentId,
            uploaderId:      user.id,
          },
        );
      } else {
        // User chưa được gán khoa — chỉ thấy public đã duyệt + private của mình.
        qb.andWhere(
          `(${publicStoredOrApproved} OR (doc.visibility = :priv AND uploader.id = :uploaderId))`,
          {
            public:          DocumentVisibility.PUBLIC,
            publicStatuses: [DocumentStatus.STORED, DocumentStatus.APPROVED],
            priv:            DocumentVisibility.PRIVATE,
            uploaderId:      user.id,
          },
        );
      }
    }

    if (query.status) {
      qb.andWhere('doc.status = :status', { status: query.status });
    }

    if (query.keyword) {
      // Tạm thời tìm theo tên/tiêu đề trong MySQL.
      // Giai đoạn 4 sẽ thay bằng gọi Meilisearch để tìm cả nội dung bên trong PDF.
      qb.andWhere('(doc.title LIKE :kw OR doc.originalFilename LIKE :kw)', {
        kw: `%${query.keyword}%`,
      });
    }

    // ─── Bộ lọc nâng cao ───────────────────────────────────────
    if (query.dateFrom) {
      qb.andWhere('doc.createdAt >= :dateFrom', {
        dateFrom: new Date(query.dateFrom),
      });
    }

    if (query.dateTo) {
      // Lấy hết ngày dateTo (23:59:59.999)
      const end = new Date(query.dateTo);
      end.setHours(23, 59, 59, 999);
      qb.andWhere('doc.createdAt <= :dateTo', { dateTo: end });
    }

    // uploaderId chỉ áp dụng cho Admin và Trưởng Khoa (USER đã bị scope cứng ở trên)
    if (query.uploaderId && user.role !== UserRole.USER) {
      qb.andWhere('uploader.id = :uploaderId', {
        uploaderId: query.uploaderId,
      });
    }

    if (query.minSize) {
      qb.andWhere('doc.fileSizeBytes >= :minSize', {
        minSize: parseInt(query.minSize, 10),
      });
    }

    if (query.maxSize) {
      qb.andWhere('doc.fileSizeBytes <= :maxSize', {
        maxSize: parseInt(query.maxSize, 10),
      });
    }

    qb.orderBy('doc.createdAt', 'DESC');

    // ─── Pagination ────────────────────────────────────────────
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();

    // ĐÃ SỬA: bỏ fs.existsSync() đồng bộ trong vòng lặp map() — đây chính là
    // NGUYÊN NHÂN CHÍNH gây nghẽn event loop / rò rỉ RAM / crash khi test tải
    // 2000 VU. fs.existsSync() chặn cứng toàn bộ event loop Node.js mỗi lần
    // gọi (I/O đĩa đồng bộ). Với route này bị gọi bởi hàng nghìn user đồng
    // thời, mỗi response x 20 record → event loop bị khóa hàng nghìn lần
    // liên tiếp, request mới phải xếp hàng, object tích lũy trong RAM ngày
    // càng nhiều cho đến khi PM2 coi worker "treo" và kill cứng.
    //
    // fileExists không còn cần thiết ở API danh sách: khi user bấm
    // xem/tải file thật sự, getFileForDownload() đã tự kiểm tra và trả lỗi
    // rõ ràng "File đã bị xóa khỏi ổ đĩa" nếu không tồn tại.
    return { data, total, page, limit };
  }

  // ─── TẢI FILE (kiểm tra quyền truy cập) ───────────────────
  async getArchiveYears(user: AuthUser) {
    const qb = this.buildArchiveQuery(user)
      .select('YEAR(doc.approved_at)', 'year')
      .addSelect('COUNT(doc.id)', 'count')
      .groupBy('YEAR(doc.approved_at)')
      .orderBy('year', 'DESC');

    const rows = await qb.getRawMany();
    return rows.map((row) => ({
      year: Number(row.year),
      count: Number(row.count),
    }));
  }

  async getArchiveDates(year: string, user: AuthUser) {
    this.assertYear(year);

    const qb = this.buildArchiveQuery(user)
      .andWhere('doc.approved_at >= :start AND doc.approved_at < :end', {
        start: `${year}-01-01`,
        end: `${Number(year) + 1}-01-01`,
      })
      .select("DATE_FORMAT(doc.approved_at, '%Y-%m-%d')", 'date')
      .addSelect('COUNT(doc.id)', 'count')
      .groupBy("DATE_FORMAT(doc.approved_at, '%Y-%m-%d')")
      .orderBy('date', 'DESC');

    const rows = await qb.getRawMany();
    return rows.map((row) => ({
      date: row.date,
      count: Number(row.count),
    }));
  }

  async getArchiveFiles(year: string, date: string, user: AuthUser) {
    this.assertYear(year);
    this.assertDate(date);
    if (!date.startsWith(`${year}-`)) {
      throw new BadRequestException('Ngay khong thuoc nam da chon');
    }

    const endDate = new Date(`${date}T00:00:00.000Z`);
    endDate.setUTCDate(endDate.getUTCDate() + 1);

    return this.buildArchiveQuery(user)
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.approvedBy', 'approvedBy')
      .leftJoinAndSelect('doc.documentType', 'documentType')
      .andWhere('doc.approved_at >= :start AND doc.approved_at < :end', {
        start: date,
        end: endDate.toISOString().slice(0, 10),
      })
      .orderBy('doc.approvedAt', 'DESC')
      .getMany();
  }

  async getFileForDownload(id: string, user: AuthUser) {
    if (user.role === UserRole.USER) {
      throw new ForbiddenException('Nguoi dung khong duoc tai file ve');
    }

    if (user.fileId && user.fileId !== id) {
      throw new ForbiddenException('Link tải file không hợp lệ');
    }
    const doc = await this.getOrFail(id);

    const isOwner = doc.uploader && (doc.uploader as any).id === user.id;
    const isAdmin = user.role === UserRole.ADMIN;
    const isSameDept = doc.department?.id === user.departmentId;

    // ─── Kiểm tra quyền theo visibility ──────────────────────
    let canAccess = false;
    const vis = doc.visibility ?? DocumentVisibility.DEPARTMENT;

    if (isAdmin)                                      canAccess = true;
    else if (vis === DocumentVisibility.PUBLIC)       canAccess = true;
    else if (vis === DocumentVisibility.DEPARTMENT)   canAccess = isOwner || isSameDept;
    else if (vis === DocumentVisibility.PRIVATE)      canAccess = isOwner;
    else                                              canAccess = isOwner || isSameDept;

    if (!canAccess) {
      throw new ForbiddenException('Bạn không có quyền truy cập tài liệu này');
    }

    const canViewPending = isAdmin ||
      (user.role === UserRole.DEPARTMENT_HEAD && isSameDept);
    const isPublished =
      doc.status === DocumentStatus.STORED || doc.status === DocumentStatus.APPROVED;
    if (!isPublished && !canViewPending) {
      throw new ForbiddenException('Tài liệu chưa được duyệt/lưu trữ chính thức');
    }

    const storagePath = doc.file?.storageKey ?? doc.storagePath;
    const absPath = path.isAbsolute(storagePath)
      ? storagePath
      : path.resolve(process.cwd(), storagePath);

    // Giữ nguyên fs.existsSync() ở đây: route này chỉ xử lý 1 file / request
    // (không phải vòng lặp N record), nên không gây nghẽn event loop đáng kể.
    if (!fs.existsSync(absPath)) {
      if (doc.status === DocumentStatus.PENDING) {
        throw new NotFoundException('File tạm thời không còn trên server. Vui lòng upload lại.');
      }
      throw new NotFoundException('File đã bị xóa khỏi ổ đĩa. Vui lòng liên hệ quản trị viên.');
    }

    doc.storagePath = absPath;
    await this.log(user.id, 'download', doc.id, {});
    return doc;
  }

  async createDownloadUrl(id: string, user: AuthUser): Promise<{ url: string; expiresIn: number }> {
    if (user.role === UserRole.USER) {
      throw new ForbiddenException('Nguoi dung khong duoc tao link tai file');
    }

    await this.getFileForDownload(id, user);
    const expiresIn = 5 * 60;
    const token = await this.jwtService.signAsync(
      { sub: user.id, email: (user as any).email, role: user.role, departmentId: user.departmentId, fileId: id, type: 'file-download' },
      { expiresIn },
    );
    return { url: `/documents/${id}/download?token=${encodeURIComponent(token)}`, expiresIn };
  }

  async getFileForView(doc: Document, user: AuthUser) {
    const storagePath = doc.file?.storageKey ?? doc.storagePath;
    const absPath = path.isAbsolute(storagePath)
      ? storagePath
      : path.resolve(process.cwd(), storagePath);

    if (!fs.existsSync(absPath)) {
      throw new NotFoundException('File da bi xoa khoi o dia. Vui long lien he quan tri vien.');
    }

    await this.accessLogsRepo.save(
      this.accessLogsRepo.create({
        document: { id: doc.id } as any,
        user: { id: user.id } as any,
        action: AccessLogAction.VIEWED,
      }),
    );

    return {
      path: absPath,
      filename: doc.originalFilename,
      mimeType: doc.file?.mimeType ?? 'application/pdf',
    };
  }

  // ─── CẬP NHẬT THÔNG TIN CƠ BẢN (title, description, departmentId) ────────
  async updateDocument(
    id: string,
    dto: {
      title?: string;
      summary?: string;
      referenceNo?: string;
      issuingUnit?: string;
      organizingBody?: string;
      receivedDate?: string;
      documentNumber?: string;
      securityLevel?: string;
      authorName?: string;
      description?: string;
      departmentId?: string;
    },
    actor: AuthUser,
  ): Promise<Document> {
    const doc = await this.getOrFail(id);

    if (dto.title !== undefined) doc.title = dto.title;
    if (dto.summary !== undefined) doc.summary = dto.summary;
    if (dto.referenceNo !== undefined) doc.referenceNo = dto.referenceNo;
    if (dto.issuingUnit !== undefined) doc.issuingUnit = dto.issuingUnit;
    if (dto.organizingBody !== undefined) doc.organizingBody = dto.organizingBody;
    if (dto.receivedDate !== undefined) doc.receivedDate = dto.receivedDate ? new Date(dto.receivedDate) as any : null as any;
    if (dto.documentNumber !== undefined) doc.documentNumber = dto.documentNumber;
    if (dto.securityLevel !== undefined) doc.securityLevel = dto.securityLevel;
    if (dto.authorName !== undefined) doc.authorName = dto.authorName;
    if (dto.description !== undefined) doc.description = dto.description;
    if (dto.departmentId !== undefined) {
      doc.department = dto.departmentId ? ({ id: dto.departmentId } as any) : null;
    }

    const saved = await this.docsRepo.save(doc);
    await this.log(actor.id, 'update', id, { dto });
    return saved;
  }

  // ─── CẬP NHẬT METADATA (Admin gán loại hồ sơ, phân loại giá trị) ────────
  async updateMetadata(
    id: string,
    dto: {
      documentTypeId?: string;
      classificationValue?: ClassificationValue;
      documentDate?: string;
      patientDeathDate?: string;
      reviewStatus?: ReviewStatus;
    },
    actor: AuthUser,
  ): Promise<Document> {
    const doc = await this.getOrFail(id);

    if (dto.documentTypeId !== undefined) {
      doc.documentType = dto.documentTypeId ? ({ id: dto.documentTypeId } as any) : null;
    }
    if (dto.classificationValue !== undefined) {
      doc.classificationValue = dto.classificationValue;
    }
    if (dto.documentDate !== undefined) {
      doc.documentDate = (dto.documentDate ? new Date(dto.documentDate) : null) as any;
    }
    if (dto.patientDeathDate !== undefined) {
      doc.patientDeathDate = (dto.patientDeathDate ? new Date(dto.patientDeathDate) : null) as any;
    }
    if (dto.reviewStatus !== undefined) {
      doc.reviewStatus = dto.reviewStatus;
    }

    const saved = await this.docsRepo.save(doc);
    await this.log(actor.id, 'update_metadata', id, { dto });

    // Nếu tài liệu đã được duyệt, tính lại hạn lưu trữ
    if (saved.status === DocumentStatus.STORED) {
      const docWithType = await this.docsRepo.findOne({
        where: { id },
        relations: ['documentType'],
      });
      if (docWithType) await this.retentionService.computeAndSaveExpiry(docWithType);
    }

    return saved;
  }

  // ─── COMMENTS ─────────────────────────────────────────────
  async addComment(docId: string, content: string, user: AuthUser): Promise<DocumentComment> {
    // Kiểm tra document tồn tại và user có quyền xem
    await this.getOrFail(docId);

    const comment = this.commentRepo.create({
      document: { id: docId } as any,
      author: { id: user.id } as any,
      content,
    });
    return this.commentRepo.save(comment);
  }

  async getComments(docId: string, user: AuthUser): Promise<DocumentComment[]> {
    await this.getOrFail(docId);

    return this.commentRepo.find({
      where: { document: { id: docId } },
      relations: ['author'],
      order: { createdAt: 'ASC' },
    });
  }

  async deleteComment(docId: string, commentId: string, user: AuthUser): Promise<void> {
    const comment = await this.commentRepo.findOne({
      where: { id: commentId, document: { id: docId } },
      relations: ['author'],
    });
    if (!comment) throw new NotFoundException('Không tìm thấy ghi chú');

    const isAuthor = (comment.author as any)?.id === user.id;
    if (!isAuthor && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Bạn không có quyền xóa ghi chú này');
    }

    await this.commentRepo.remove(comment);
  }

  // ─── Helpers ───────────────────────────────────────────────
  private buildArchiveQuery(user: AuthUser) {
    const qb = this.docsRepo
      .createQueryBuilder('doc')
      .where('doc.status = :status', { status: DocumentStatus.STORED })
      .andWhere('doc.approved_at IS NOT NULL');

    if (user.role === UserRole.DEPARTMENT_HEAD) {
      qb.leftJoin('doc.department', 'scopeDepartment')
        .andWhere('scopeDepartment.id = :departmentId', {
          departmentId: user.departmentId,
        });
    } else if (user.role === UserRole.USER) {
      qb.leftJoin('doc.uploader', 'scopeUploader')
        .andWhere('scopeUploader.id = :userId', { userId: user.id });
    }

    return qb;
  }

  private assertYear(year: string) {
    if (!/^\d{4}$/.test(year)) {
      throw new BadRequestException('Nam khong hop le');
    }
  }

  private assertDate(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('Ngay khong hop le, dung dinh dang YYYY-MM-DD');
    }

    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new BadRequestException('Ngay khong ton tai');
    }
  }

  private async getOrFail(id: string): Promise<Document> {
    const doc = await this.docsRepo.findOne({
      where: { id },
      relations: ['uploader', 'department', 'approvedBy', 'documentType', 'file'],
    });
    if (!doc) throw new NotFoundException('Không tìm thấy tài liệu');

    // Load đủ email + fullName cho uploader (dùng để gửi notification)
    if (doc.uploader?.id && !(doc.uploader as any).email) {
      const full = await this.userRepo.findOne({
        where: { id: doc.uploader.id },
        select: ['id', 'email', 'fullName'],
      });
      if (full) Object.assign(doc.uploader, full);
    }

    return doc;
  }

  private computeChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private async log(
    actorId: string,
    action: string,
    documentId: string,
    metadata: Record<string, any>,
  ) {
    const entry = this.auditRepo.create({
      actor: { id: actorId } as any,
      action,
      document: { id: documentId } as any,
      metadata,
    });
    await this.auditRepo.save(entry);
  }
}
