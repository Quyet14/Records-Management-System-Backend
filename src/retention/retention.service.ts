import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LessThan, Repository, IsNull, Not, LessThanOrEqual } from 'typeorm';
import { Document, ClassificationValue, ReviewStatus, DocumentStatus } from '../entities/document.entity';
import { RetentionBasis } from '../entities/document-type.entity';
import { assertDocumentMutable } from '../common/document-lifecycle';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AuditLog } from '../entities/audit-log.entity';

/** Hạn chót chỉnh lý tài liệu trước 01/7/2025 theo Luật 01/2011/QH13 */
const REVIEW_DEADLINE = new Date('2030-07-01');

/** Mốc phân biệt tài liệu "cũ" cần chỉnh lý */
const OLD_DOC_CUTOFF = new Date('2025-07-01');

/** Cảnh báo trước N ngày hết hạn lưu trữ */
const EXPIRY_WARNING_DAYS = 180;

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectRepository(Document)
    private docRepo: Repository<Document>,
  ) {}

  async setLegalHold(id: string, legalHold: boolean, actorId: string) {
    return this.docRepo.manager.transaction('READ COMMITTED', async m => {
      const doc = await m.findOne(Document, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!doc) throw new NotFoundException('Không tìm thấy hồ sơ.');
      if (doc.destructionStartedAt || doc.status === DocumentStatus.DESTROYED)
        throw new ConflictException({ code: 'DESTRUCTION_STARTED', message: 'Nội dung đã bắt đầu hủy; không thể thay đổi legal hold.' });
      await m.update(Document, id, { legalHold });
      await m.save(AuditLog, m.create(AuditLog, { actor: { id: actorId }, document: { id }, action: 'legal_hold',
        createdAt: new Date(), metadata: { old: doc.legalHold, new: legalHold } }));
      return { id, legalHold };
    });
  }

  // ─── Tính hạn lưu trữ cho một tài liệu ────────────────────

  /**
   * Tính và lưu expiresAt cho tài liệu dựa trên documentType.
   * Gọi sau khi Admin duyệt tài liệu.
   * Trả về null nếu không tính được (chưa có documentType hoặc vĩnh viễn).
   */
  async computeAndSaveExpiry(doc: Document): Promise<Date | null> {
    assertDocumentMutable(doc);
    // Destruction eligibility never inherits an upload-date fallback from legacy expires_at.
    doc.retentionUntil = null;
    if (!doc.documentType) { await this.docRepo.save(doc); return null; }

    const dt = doc.documentType;
    if (dt.isPermanent) {
      doc.retentionUntil = null;
      doc.expiresAt = null as any;
      // Vĩnh viễn — không set expiresAt, đảm bảo classificationValue = PERMANENT
      if (doc.classificationValue !== ClassificationValue.PERMANENT) {
        doc.classificationValue = ClassificationValue.PERMANENT;
      }
      await this.docRepo.save(doc);
      return null;
    }

    if (!dt.retentionYears || dt.retentionBasis === RetentionBasis.PERMANENT) { await this.docRepo.save(doc); return null; }

    let baseDate: Date | null = null;

    switch (dt.retentionBasis) {
      case RetentionBasis.PATIENT_DEATH_DATE:
        baseDate = doc.patientDeathDate ?? null;
        break;
      case RetentionBasis.DOCUMENT_DATE:
      default:
        // Ưu tiên documentDate, fallback về approvedAt, rồi createdAt
        baseDate = doc.documentDate ?? doc.approvedAt ?? doc.createdAt;
        break;
    }

    if (!baseDate) { await this.docRepo.save(doc); return null; }

    const expires = new Date(baseDate);
    expires.setFullYear(expires.getFullYear() + dt.retentionYears);

    doc.expiresAt = expires;
    const approvedBasis = dt.retentionBasis === RetentionBasis.PATIENT_DEATH_DATE ? doc.patientDeathDate : doc.documentDate;
    if (approvedBasis && doc.approvedAt && dt.retentionYears > 0) {
      const retention = new Date(approvedBasis);
      retention.setUTCFullYear(retention.getUTCFullYear() + dt.retentionYears);
      retention.setUTCHours(23, 59, 59, 999);
      doc.retentionUntil = retention;
    }
    if (doc.classificationValue === ClassificationValue.UNCLASSIFIED) {
      doc.classificationValue = ClassificationValue.TIMED;
    }
    await this.docRepo.save(doc);

    return expires;
  }

  // ─── Danh sách tài liệu sắp hết hạn ───────────────────────

  /**
   * Trả về tài liệu có expiresAt trong vòng EXPIRY_WARNING_DAYS ngày tới.
   */
  private documents(departmentId?: string) {
    const qb = this.docRepo.createQueryBuilder('doc');
    if (departmentId) qb.andWhere('doc.department_id = :reportDepartmentId', { reportDepartmentId: departmentId });
    return qb;
  }

  async getExpiringDocuments(days = EXPIRY_WARNING_DAYS, departmentId?: string) {
    if (!Number.isInteger(days) || days < 1 || days > 36500) throw new BadRequestException("Invalid days.");
    const now = new Date();
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + days);

    const docs = await this.documents(departmentId)
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.documentType', 'documentType')
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .andWhere('doc.expires_at IS NOT NULL')
      .andWhere('doc.expires_at > :now', { now })
      .andWhere('doc.expires_at <= :threshold', { threshold })
      .andWhere('doc.status = :status', { status: DocumentStatus.STORED })
      .orderBy('doc.expires_at', 'ASC')
      .getMany();

    return docs.map((d) => ({
      id: d.id,
      title: d.title || d.originalFilename,
      department: (d.department as any)?.name ?? '—',
      documentType: (d.documentType as any)?.name ?? '—',
      expiresAt: d.expiresAt,
      daysRemaining: Math.ceil(
        (new Date(d.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      ),
    }));
  }

  // ─── Cảnh báo chỉnh lý tài liệu trước 01/7/2025 ───────────

  /**
   * Tài liệu hình thành trước 01/7/2025, chưa hoàn thành chỉnh lý.
   * Hạn chót: 01/7/2030.
   */
  async getPendingReviewDocuments(page = 1, limit = 20, departmentId?: string) {
    if (!Number.isInteger(page) || page < 1 || page > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException("Invalid pagination.");
    const [data, total] = await this.documents(departmentId)
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.documentType', 'documentType')
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .andWhere('(doc.document_date < :cutoff OR (doc.document_date IS NULL AND doc.created_at < :cutoff))', {
        cutoff: OLD_DOC_CUTOFF,
      })
      .andWhere('doc.review_status != :done', { done: ReviewStatus.COMPLETED })
      .orderBy('doc.documentDate', 'ASC')
      .addOrderBy('doc.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const now = new Date();
    const daysToDeadline = Math.ceil(
      (REVIEW_DEADLINE.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      data: data.map((d) => ({
        id: d.id,
        title: d.title || d.originalFilename,
        department: (d.department as any)?.name ?? '—',
        documentType: (d.documentType as any)?.name ?? '—',
        documentDate: d.documentDate ?? d.createdAt,
        reviewStatus: d.reviewStatus,
      })),
      total,
      page,
      limit,
      deadline: REVIEW_DEADLINE,
      daysToDeadline,
    };
  }

  /** Thống kê tóm tắt về chỉnh lý */
  async getReviewSummary(departmentId?: string) {
    const now = new Date();
    const daysToDeadline = Math.ceil(
      (REVIEW_DEADLINE.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Đếm tài liệu trước 01/7/2025 theo từng trạng thái chỉnh lý
    const rows = await this.documents(departmentId)
      .select('doc.review_status', 'reviewStatus')
      .addSelect('COUNT(*)', 'count')
      .andWhere(
        '(doc.document_date < :cutoff OR (doc.document_date IS NULL AND doc.created_at < :cutoff))',
        { cutoff: OLD_DOC_CUTOFF },
      )
      .groupBy('doc.review_status')
      .getRawMany();

    const byStatus = Object.fromEntries(
      rows.map((r) => [r.reviewStatus, Number(r.count)]),
    );

    const total = (Object.values(byStatus) as number[]).reduce((a, b) => a + b, 0);
    const completed = byStatus[ReviewStatus.COMPLETED] ?? 0;
    const remaining = total - completed;

    return {
      deadline: REVIEW_DEADLINE,
      daysToDeadline,
      totalOldDocuments: total,
      completed,
      remaining,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 100,
      byStatus,
    };
  }

  /** Cập nhật trạng thái chỉnh lý cho một tài liệu */
  async updateReviewStatus(id: string, reviewStatus: ReviewStatus): Promise<void> {
    await this.docRepo.update(id, { reviewStatus });
  }

  // ─── Cron jobs ─────────────────────────────────────────────

  /** Mỗi ngày 6h sáng: log cảnh báo tài liệu sắp hết hạn */
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async cronExpiryWarning() {
    const expiring = await this.getExpiringDocuments(EXPIRY_WARNING_DAYS);
    if (expiring.length > 0) {
      this.logger.warn(
        `[Retention] ${expiring.length} tài liệu sẽ hết hạn lưu trữ trong ${EXPIRY_WARNING_DAYS} ngày tới`,
      );
    }
  }

  /** Mỗi thứ Hai 7h sáng: cảnh báo tiến độ chỉnh lý */
  @Cron('0 7 * * 1')
  async cronReviewDeadlineWarning() {
    const summary = await this.getReviewSummary();
    const now = new Date();

    if (summary.daysToDeadline <= 0) {
      this.logger.error(
        `[Retention] ĐÃ QUÁ HẠN CHỈNH LÝ 01/7/2030! Còn ${summary.remaining} tài liệu chưa hoàn thành.`,
      );
      return;
    }

    if (summary.remaining > 0) {
      this.logger.warn(
        `[Retention] Chỉnh lý tài liệu trước 01/7/2025: còn ${summary.remaining}/${summary.totalOldDocuments} tài liệu chưa xong. Hạn chót: ${REVIEW_DEADLINE.toLocaleDateString('vi-VN')} (còn ${summary.daysToDeadline} ngày).`,
      );
    } else {
      this.logger.log('[Retention] Tất cả tài liệu trước 01/7/2025 đã hoàn thành chỉnh lý.');
    }
  }
}
