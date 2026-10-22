import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import {
  Document,
  DocumentStatus,
  ClassificationValue,
  ReviewStatus,
} from '../entities/document.entity';
import { User } from '../entities/user.entity';
import { Department } from '../entities/department.entity';
import { DocumentType } from '../entities/document-type.entity';

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(Document) private docRepo: Repository<Document>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Department) private deptRepo: Repository<Department>,
    @InjectRepository(DocumentType) private docTypeRepo: Repository<DocumentType>,
  ) {}

  // ─── Tổng quan hệ thống ────────────────────────────────────
  private documents(departmentId?: string) {
    const qb = this.docRepo.createQueryBuilder('doc');
    if (departmentId) qb.andWhere('doc.department_id = :reportDepartmentId', { reportDepartmentId: departmentId });
    return qb;
  }

  async getOverview(departmentId?: string) {
    const [totalDocs, totalUsers, totalDepts] = await Promise.all([
      this.docRepo.count({ where: { status: Not(DocumentStatus.DESTROYED), ...(departmentId ? { department: { id: departmentId } } : {}) } }),
      this.userRepo.count(departmentId ? { where: { department: { id: departmentId } } } : {}),
      this.deptRepo.count(departmentId ? { where: { id: departmentId } } : {}),
    ]);

    // Đếm theo từng trạng thái
    const byStatus = await this.documents(departmentId)
      .select('doc.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect("COALESCE(SUM(CASE WHEN doc.status != 'destroyed' THEN doc.fileSizeBytes ELSE 0 END), 0)", 'totalBytes')
      .groupBy('doc.status')
      .getRawMany();

    // Tổng dung lượng đã lưu trữ
    const storedSize = await this.documents(departmentId)
      .select('COALESCE(SUM(doc.fileSizeBytes), 0)', 'bytes')
      .andWhere('doc.status = :status', { status: DocumentStatus.STORED })
      .getRawOne();

    return {
      totalDocuments: totalDocs,
      totalUsers,
      totalDepartments: totalDepts,
      storedSizeBytes: Number(storedSize?.bytes ?? 0),
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: Number(r.count),
        totalBytes: Number(r.totalBytes),
      })),
    };
  }

  // ─── Thống kê theo khoa ────────────────────────────────────
  async getByDepartment(departmentId?: string) {
    const rows = await this.documents(departmentId)
      .leftJoin('doc.department', 'dept')
      .select('dept.id', 'departmentId')
      .addSelect('dept.name', 'departmentName')
      .addSelect("COUNT(CASE WHEN doc.status != 'destroyed' THEN doc.id END)", 'totalDocuments')
      .addSelect("COALESCE(SUM(CASE WHEN doc.status != 'destroyed' THEN doc.fileSizeBytes ELSE 0 END), 0)", 'totalBytes')
      .addSelect(
        `SUM(CASE WHEN doc.status = 'stored' THEN 1 ELSE 0 END)`,
        'storedCount',
      )
      .addSelect(
        `SUM(CASE WHEN doc.status = 'pending' THEN 1 ELSE 0 END)`,
        'pendingCount',
      )
      .addSelect(
        `SUM(CASE WHEN doc.status = 'rejected' THEN 1 ELSE 0 END)`,
        'rejectedCount',
      )
      .groupBy('dept.id')
      .addGroupBy('dept.name')
      .orderBy('totalDocuments', 'DESC')
      .getRawMany();

    return rows.map((r) => ({
      departmentId: r.departmentId,
      departmentName: r.departmentName ?? 'Không xác định',
      totalDocuments: Number(r.totalDocuments),
      totalBytes: Number(r.totalBytes),
      storedCount: Number(r.storedCount),
      pendingCount: Number(r.pendingCount),
      rejectedCount: Number(r.rejectedCount),
    }));
  }

  // ─── Thống kê theo năm ────────────────────────────────────
  async getByYear(year?: number, departmentId?: string) {
    if (year !== undefined && (!Number.isInteger(year) || year < 1900 || year > 9999)) throw new BadRequestException("Invalid year.");
    const targetYear = year || new Date().getFullYear();

    // Theo tháng trong năm
    const monthly = await this.documents(departmentId)
      .select('MONTH(doc.createdAt)', 'month')
      .addSelect("COUNT(CASE WHEN doc.status != 'destroyed' THEN doc.id END)", 'totalDocuments')
      .addSelect("COALESCE(SUM(CASE WHEN doc.status != 'destroyed' THEN doc.fileSizeBytes ELSE 0 END), 0)", 'totalBytes')
      .andWhere('YEAR(doc.createdAt) = :year', { year: targetYear })
      .groupBy('MONTH(doc.createdAt)')
      .orderBy('month', 'ASC')
      .getRawMany();

    // Điền 0 cho các tháng không có dữ liệu
    const monthMap = new Map(
      monthly.map((r) => [Number(r.month), r]),
    );
    const result = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const row = monthMap.get(m);
      return {
        month: m,
        totalDocuments: row ? Number(row.totalDocuments) : 0,
        totalBytes: row ? Number(row.totalBytes) : 0,
      };
    });

    return { year: targetYear, monthly: result };
  }

  // ─── Tăng trưởng dung lượng (theo tháng, toàn bộ lịch sử) ──
  async getStorageGrowth(departmentId?: string) {
    const rows = await this.documents(departmentId)
      .select('YEAR(doc.createdAt)', 'year')
      .addSelect('MONTH(doc.createdAt)', 'month')
      .addSelect('COALESCE(SUM(doc.fileSizeBytes), 0)', 'addedBytes')
      .addSelect('COUNT(doc.id)', 'addedDocs')
      .andWhere('doc.status = :status', { status: DocumentStatus.STORED })
      .groupBy('YEAR(doc.createdAt)')
      .addGroupBy('MONTH(doc.createdAt)')
      .orderBy('year', 'ASC')
      .addOrderBy('month', 'ASC')
      .getRawMany();

    // Tính cumulative (tổng tích lũy)
    let cumBytes = 0;
    let cumDocs = 0;
    return rows.map((r) => {
      cumBytes += Number(r.addedBytes);
      cumDocs += Number(r.addedDocs);
      return {
        year: Number(r.year),
        month: Number(r.month),
        addedBytes: Number(r.addedBytes),
        addedDocs: Number(r.addedDocs),
        cumulativeBytes: cumBytes,
        cumulativeDocs: cumDocs,
      };
    });
  }

  // ─── Top người dùng upload nhiều nhất ─────────────────────
  async getTopUploaders(limit = 10, departmentId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException("Invalid limit.");
    const rows = await this.documents(departmentId)
      .leftJoin('doc.uploader', 'user')
      .select('user.id', 'userId')
      .addSelect('user.fullName', 'fullName')
      .addSelect('user.email', 'email')
      .addSelect("COUNT(CASE WHEN doc.status != 'destroyed' THEN doc.id END)", 'totalDocuments')
      .addSelect("COALESCE(SUM(CASE WHEN doc.status != 'destroyed' THEN doc.fileSizeBytes ELSE 0 END), 0)", 'totalBytes')
      .groupBy('user.id')
      .addGroupBy('user.fullName')
      .addGroupBy('user.email')
      .orderBy('totalDocuments', 'DESC')
      .limit(limit)
      .getRawMany();

    return rows.map((r) => ({
      userId: r.userId,
      fullName: r.fullName,
      email: r.email,
      totalDocuments: Number(r.totalDocuments),
      totalBytes: Number(r.totalBytes),
    }));
  }

  // ─── Thống kê theo loại hồ sơ ─────────────────────────────
  async getByDocumentType(departmentId?: string) {
    const rows = await this.documents(departmentId)
      .leftJoin('doc.documentType', 'dt')
      .select('dt.id', 'typeId')
      .addSelect('dt.code', 'code')
      .addSelect('dt.name', 'typeName')
      .addSelect('dt.retentionYears', 'retentionYears')
      .addSelect('dt.isPermanent', 'isPermanent')
      .addSelect("COUNT(CASE WHEN doc.status != 'destroyed' THEN doc.id END)", 'totalDocuments')
      .addSelect("COALESCE(SUM(CASE WHEN doc.status != 'destroyed' THEN doc.fileSizeBytes ELSE 0 END), 0)", 'totalBytes')
      .addSelect(
        `SUM(CASE WHEN doc.status = 'stored' THEN 1 ELSE 0 END)`,
        'storedCount',
      )
      .groupBy('dt.id')
      .addGroupBy('dt.code')
      .addGroupBy('dt.name')
      .addGroupBy('dt.retentionYears')
      .addGroupBy('dt.isPermanent')
      .orderBy('totalDocuments', 'DESC')
      .getRawMany();

    // Đếm riêng tài liệu chưa gán loại hồ sơ
    const unclassifiedCount = await this.docRepo.count({
      where: { documentType: IsNull(), status: Not(DocumentStatus.DESTROYED), ...(departmentId ? { department: { id: departmentId } } : {}) },
    });

    return {
      byType: rows.map((r) => ({
        typeId: r.typeId,
        code: r.code,
        typeName: r.typeName ?? 'Chưa phân loại',
        retentionYears: r.retentionYears ? Number(r.retentionYears) : null,
        isPermanent: Boolean(r.isPermanent),
        totalDocuments: Number(r.totalDocuments),
        totalBytes: Number(r.totalBytes),
        storedCount: Number(r.storedCount),
      })),
      unclassifiedCount,
    };
  }

  // ─── Thống kê phân loại giá trị ───────────────────────────
  async getByClassificationValue(departmentId?: string) {
    const rows = await this.documents(departmentId)
      .select('doc.classificationValue', 'classificationValue')
      .addSelect('COUNT(doc.id)', 'count')
      .addSelect("COALESCE(SUM(CASE WHEN doc.status != 'destroyed' THEN doc.fileSizeBytes ELSE 0 END), 0)", 'totalBytes')
      .groupBy('doc.classificationValue')
      .getRawMany();

    return rows.map((r) => ({
      classificationValue: r.classificationValue,
      count: Number(r.count),
      totalBytes: Number(r.totalBytes),
    }));
  }

  // ─── Thống kê chỉnh lý tài liệu cũ ───────────────────────
  async getReviewProgress(departmentId?: string) {
    const OLD_DOC_CUTOFF = new Date('2025-07-01');
    const REVIEW_DEADLINE = new Date('2030-07-01');
    const now = new Date();

    const rows = await this.documents(departmentId)
      .select('doc.reviewStatus', 'reviewStatus')
      .addSelect('COUNT(doc.id)', 'count')
      .andWhere(
        '(doc.document_date < :cutoff OR (doc.document_date IS NULL AND doc.created_at < :cutoff))',
        { cutoff: OLD_DOC_CUTOFF },
      )
      .groupBy('doc.reviewStatus')
      .getRawMany();

    const byStatus = Object.fromEntries(
      rows.map((r) => [r.reviewStatus, Number(r.count)]),
    );

    const total = (Object.values(byStatus) as number[]).reduce((a, b) => a + b, 0);
    const completed = byStatus[ReviewStatus.COMPLETED] ?? 0;
    const daysToDeadline = Math.ceil(
      (REVIEW_DEADLINE.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      deadline: REVIEW_DEADLINE,
      daysToDeadline,
      totalOldDocuments: total,
      completed,
      remaining: total - completed,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 100,
      byStatus,
    };
  }

  // ─── Tài liệu sắp hết hạn lưu trữ ────────────────────────
  async getExpiringSoon(days = 180, departmentId?: string) {
    if (!Number.isInteger(days) || days < 1 || days > 36500) throw new BadRequestException("Invalid days.");
    const now = new Date();
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + days);

    const [data, total] = await this.documents(departmentId)
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.documentType', 'documentType')
      .andWhere('doc.expires_at IS NOT NULL')
      .andWhere('doc.expires_at > :now', { now })
      .andWhere('doc.expires_at <= :threshold', { threshold })
      .andWhere('doc.status = :status', { status: DocumentStatus.STORED })
      .orderBy('doc.expires_at', 'ASC')
      .getManyAndCount();

    return {
      total,
      withinDays: days,
      data: data.map((d) => ({
        id: d.id,
        title: d.title || d.originalFilename,
        department: (d.department as any)?.name ?? '—',
        documentType: (d.documentType as any)?.name ?? '—',
        expiresAt: d.expiresAt,
        daysRemaining: Math.ceil(
          (new Date(d.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        ),
      })),
    };
  }
}
