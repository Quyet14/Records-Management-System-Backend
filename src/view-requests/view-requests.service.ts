import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Document, DocumentStatus } from '../entities/document.entity';
import { canReviewDocument, canViewDepartmentDocument } from '../common/document-permissions';
import { applyDocumentSecurityScope, assertDocumentSecurityAccess } from '../common/document-security';
import { User, UserRole, UserPermission } from '../entities/user.entity';
import {
  ViewRequest,
  ViewRequestStatus,
} from '../entities/view-request.entity';
import { AccessLog, AccessLogAction } from '../entities/access-log.entity';
import { ApproveViewRequestDto } from './dto/approve-view-request.dto';
import { CreateViewRequestDto } from './dto/create-view-request.dto';
import { QueryViewRequestsDto } from './dto/query-view-requests.dto';

interface AuthUser {
  id: string;
  email?: string;
  role: UserRole;
  departmentId?: string;
  permissions?: UserPermission[];
}

const EXTEND_WINDOW_HOURS = 24;
const MAX_CONSECUTIVE_EXTENSIONS = 3;

@Injectable()
export class ViewRequestsService {
  constructor(
    @InjectRepository(ViewRequest)
    private viewRequestsRepo: Repository<ViewRequest>,
    @InjectRepository(Document) private docsRepo: Repository<Document>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(AccessLog) private accessLogsRepo: Repository<AccessLog>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(documentId: string, dto: CreateViewRequestDto, user: AuthUser) {
    if (user.role === UserRole.USER && !(user.permissions ?? []).includes(UserPermission.REQUEST_DOCUMENT_VIEW)) {
      throw new ForbiddenException('Bạn chưa được cấp quyền gửi yêu cầu xem tài liệu');
    }
    const doc = await this.docsRepo.findOne({
      where: { id: documentId },
      relations: ['department', 'uploader'],
    });
    if (!doc) throw new NotFoundException('Khong tim thay tai lieu');
    assertDocumentSecurityAccess(doc, user);

    if ((doc.uploader as any)?.id === user.id) {
      throw new BadRequestException('Ban la nguoi tai len tai lieu nay nen co the xem truc tiep');
    }

    const isPublished =
      doc.status === DocumentStatus.STORED ||
      doc.status === DocumentStatus.APPROVED;
    if (!isPublished) {
      throw new BadRequestException('Tai lieu chua san sang de yeu cau xem');
    }

    const existingPending = await this.viewRequestsRepo.findOne({
      where: {
        document: { id: documentId },
        requester: { id: user.id },
        status: ViewRequestStatus.PENDING,
      },
    });
    if (existingPending) return existingPending;

    const request = await this.viewRequestsRepo.save(
      this.viewRequestsRepo.create({
        document: { id: documentId } as any,
        requester: { id: user.id } as any,
        reason: dto.reason,
        requestedDuration: dto.requestedDuration ?? null,
        status: ViewRequestStatus.PENDING,
      }),
    );

    await this.logAccess(documentId, user.id, AccessLogAction.REQUESTED);

    this.eventEmitter.emit('view-request.created', {
      viewRequestId: request.id,
      documentId,
      documentTitle: doc.title || doc.originalFilename,
      requesterId: user.id,
      departmentId: doc.department?.id ?? null,
      reason: dto.reason,
    });

    return request;
  }

  async extend(id: string, dto: CreateViewRequestDto, user: AuthUser) {
    if (user.role === UserRole.USER && !(user.permissions ?? []).includes(UserPermission.REQUEST_DOCUMENT_VIEW)) {
      throw new ForbiddenException('Bạn chưa được cấp quyền gửi yêu cầu xem tài liệu');
    }
    const original = await this.viewRequestsRepo.findOne({
      where: { id },
      relations: ['document', 'document.department', 'document.uploader', 'requester', 'extendedFromRequest'],
    });
    if (!original) throw new NotFoundException('Khong tim thay yeu cau xem goc');
    assertDocumentSecurityAccess(original.document, user);

    if (original.requester.id !== user.id) {
      throw new ForbiddenException('Ban chi co the gia han yeu cau xem cua chinh minh');
    }

    if (
      original.status !== ViewRequestStatus.APPROVED ||
      !original.accessExpiresAt ||
      original.accessExpiresAt <= new Date()
    ) {
      throw new BadRequestException('Chi co the gia han yeu cau da duoc duyet va con han');
    }

    const msUntilExpiry = original.accessExpiresAt.getTime() - Date.now();
    const extendWindowMs = EXTEND_WINDOW_HOURS * 60 * 60 * 1000;
    if (msUntilExpiry > extendWindowMs) {
      throw new BadRequestException('Chi co the gia han trong 24 gio cuoi cua thoi han xem');
    }

    const extensionCount = await this.countConsecutiveExtensions(original);
    if (extensionCount >= MAX_CONSECUTIVE_EXTENSIONS) {
      throw new BadRequestException('Da dat so lan gia han toi da cho tai lieu nay');
    }

    const existingPendingExtension = await this.viewRequestsRepo
      .createQueryBuilder('vr')
      .where('vr.document_id = :documentId', { documentId: original.document.id })
      .andWhere('vr.requester_id = :requesterId', { requesterId: user.id })
      .andWhere('vr.status = :status', { status: ViewRequestStatus.PENDING })
      .andWhere('vr.extended_from_request_id IS NOT NULL')
      .getOne();
    if (existingPendingExtension) return existingPendingExtension;

    const request = await this.viewRequestsRepo.save(
      this.viewRequestsRepo.create({
        document: { id: original.document.id } as any,
        requester: { id: user.id } as any,
        reason: dto.reason,
        requestedDuration: dto.requestedDuration ?? null,
        status: ViewRequestStatus.PENDING,
        extendedFromRequest: { id: original.id } as any,
      }),
    );

    await this.logAccess(original.document.id, user.id, AccessLogAction.REQUESTED);

    this.eventEmitter.emit('view-request.created', {
      viewRequestId: request.id,
      documentId: original.document.id,
      documentTitle: original.document.title || original.document.originalFilename,
      requesterId: user.id,
      departmentId: original.document.department?.id ?? null,
      reason: dto.reason,
      extendedFromRequestId: original.id,
    });

    return request;
  }

  async findAll(query: QueryViewRequestsDto, user: AuthUser) {
    this.assertCanReview(user);

    const qb = this.viewRequestsRepo
      .createQueryBuilder('vr')
      .leftJoinAndSelect('vr.document', 'document')
      .leftJoinAndSelect('document.department', 'department')
      .leftJoinAndSelect('vr.requester', 'requester')
      .leftJoinAndSelect('vr.approver', 'approver')
      .orderBy('vr.createdAt', 'DESC');

    if (query.status) {
      qb.andWhere('vr.status = :status', { status: query.status });
    }

    const mustScopeDepartment =
      user.role === UserRole.DEPARTMENT_HEAD || query.scope === 'my-department';
    if (mustScopeDepartment) {
      if (!user.departmentId) {
        throw new ForbiddenException('Tai khoan chua duoc gan khoa');
      }
      qb.andWhere('department.id = :departmentId', {
        departmentId: user.departmentId,
      });
    }

    applyDocumentSecurityScope(qb, user, 'document');
    return qb.getMany();
  }

  async getViewStatus(documentId: string, user: AuthUser) {
    const doc = await this.docsRepo.findOne({
      where: { id: documentId },
      relations: ['uploader', 'department'],
    });
    if (!doc) throw new NotFoundException('Khong tim thay tai lieu');
    assertDocumentSecurityAccess(doc, user);

    if ((doc.uploader as any)?.id === user.id) {
      return {
        status: 'owner',
        canView: true,
        expiresAt: null,
        decisionNote: '',
      };
    }

    if (
      [DocumentStatus.PENDING, DocumentStatus.APPROVED, DocumentStatus.STORED].includes(doc.status)
      && canReviewDocument(doc, user)
    ) {
      return { status: 'approved', canView: true, expiresAt: null, accessSource: 'document_review' };
    }

    if (canViewDepartmentDocument(doc, user)) {
      return { status: 'approved', canView: true, expiresAt: null, accessSource: 'department_permission' };
    }

    const requests = await this.viewRequestsRepo.find({
      where: {
        document: { id: documentId },
        requester: { id: user.id },
      },
      order: { createdAt: 'DESC' },
    });

    if (requests.length === 0) {
      return { status: 'none' };
    }

    const now = new Date();
    const activeApproved = requests.find(
      (request) =>
        request.status === ViewRequestStatus.APPROVED &&
        request.accessExpiresAt &&
        request.accessExpiresAt > now,
    );
    if (activeApproved) {
      return {
        status: ViewRequestStatus.APPROVED,
        expiresAt: activeApproved.accessExpiresAt?.toISOString() ?? null,
        decisionNote: activeApproved.decisionNote ?? '',
      };
    }

    const pending = requests.find(
      (request) => request.status === ViewRequestStatus.PENDING,
    );
    if (pending) {
      return {
        status: ViewRequestStatus.PENDING,
        expiresAt: null,
        decisionNote: pending.decisionNote ?? '',
      };
    }

    const latest = requests[0];
    const status =
      latest.status === ViewRequestStatus.APPROVED &&
      latest.accessExpiresAt &&
      latest.accessExpiresAt <= now
        ? ViewRequestStatus.EXPIRED
        : latest.status;

    return {
      status,
      expiresAt: latest.accessExpiresAt?.toISOString() ?? null,
      decisionNote: latest.decisionNote ?? '',
    };
  }

  async approve(id: string, dto: ApproveViewRequestDto, user: AuthUser) {
    const request = await this.getForDecision(id, user);
    assertDocumentSecurityAccess(request.document, {
      id: request.requester.id,
      role: request.requester.role,
      departmentId: request.requester.department?.id,
    });
    if (request.status !== ViewRequestStatus.PENDING) {
      throw new ForbiddenException('Yeu cau nay da duoc xu ly truoc do');
    }

    const maxDuration = request.document.documentType?.maxViewDurationDays;
    if (maxDuration && dto.approvedDuration > maxDuration) {
      throw new BadRequestException(
        `Thoi han duyet khong duoc vuot qua ${maxDuration} ngay cho loai tai lieu nay`,
      );
    }

    const expiresAt = new Date(Date.now() + dto.approvedDuration * 24 * 60 * 60 * 1000);

    request.status = ViewRequestStatus.APPROVED;
    request.approver = { id: user.id } as any;
    request.approvedDuration = dto.approvedDuration;
    request.accessExpiresAt = expiresAt;
    request.decidedAt = new Date();

    const saved = await this.viewRequestsRepo.save(request);
    await this.logAccess(request.document.id, user.id, AccessLogAction.APPROVED);

    this.eventEmitter.emit('view-request.approved', {
      viewRequestId: saved.id,
      documentId: request.document.id,
      documentTitle: request.document.title || request.document.originalFilename,
      requesterId: request.requester.id,
      requesterEmail: request.requester.email,
      requesterName: request.requester.fullName,
      approverName: user.email ?? user.id,
      accessExpiresAt: expiresAt,
    });

    return saved;
  }

  async reject(id: string, decisionNote: string, user: AuthUser) {
    const request = await this.getForDecision(id, user);
    if (request.status !== ViewRequestStatus.PENDING) {
      throw new ForbiddenException('Yeu cau nay da duoc xu ly truoc do');
    }

    request.status = ViewRequestStatus.REJECTED;
    request.approver = { id: user.id } as any;
    request.decisionNote = decisionNote;
    request.decidedAt = new Date();

    const saved = await this.viewRequestsRepo.save(request);
    await this.logAccess(request.document.id, user.id, AccessLogAction.REJECTED);

    this.eventEmitter.emit('view-request.rejected', {
      viewRequestId: saved.id,
      documentId: request.document.id,
      documentTitle: request.document.title || request.document.originalFilename,
      requesterId: request.requester.id,
      requesterEmail: request.requester.email,
      requesterName: request.requester.fullName,
      approverName: user.email ?? user.id,
      decisionNote,
    });

    return saved;
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireApprovedRequests() {
    await this.viewRequestsRepo.query(
      `
        UPDATE view_requests vr
        LEFT JOIN view_requests pending
          ON pending.extended_from_request_id = vr.id
          AND pending.status = ?
        SET vr.status = ?
        WHERE vr.status = ?
          AND vr.access_expires_at < ?
          AND pending.id IS NULL
      `,
      [
        ViewRequestStatus.PENDING,
        ViewRequestStatus.EXPIRED,
        ViewRequestStatus.APPROVED,
        new Date(),
      ],
    );
  }

  private async getForDecision(id: string, user: AuthUser) {
    this.assertCanReview(user);

    const request = await this.viewRequestsRepo.findOne({
      where: { id },
      relations: ['document', 'document.department', 'document.uploader', 'document.documentType', 'requester', 'requester.department'],
    });
    if (!request) throw new NotFoundException('Khong tim thay yeu cau xem');
    assertDocumentSecurityAccess(request.document, user);

    if (
      user.role === UserRole.DEPARTMENT_HEAD &&
      request.document.department?.id !== user.departmentId
    ) {
      throw new ForbiddenException('Ban chi co the xu ly yeu cau trong khoa minh');
    }

    return request;
  }

  private async countConsecutiveExtensions(request: ViewRequest) {
    let count = request.extendedFromRequest ? 1 : 0;
    let current: ViewRequest | null = request.extendedFromRequest;

    while (current) {
      current = await this.viewRequestsRepo.findOne({
        where: { id: current.id },
        relations: ['extendedFromRequest'],
      });
      current = current?.extendedFromRequest ?? null;
      if (current) count += 1;
    }

    return count;
  }

  private assertCanReview(user: AuthUser) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEPARTMENT_HEAD) {
      throw new ForbiddenException('Ban khong co quyen xu ly yeu cau xem');
    }
  }

  private async logAccess(
    documentId: string,
    userId: string,
    action: AccessLogAction,
  ) {
    await this.accessLogsRepo.save(
      this.accessLogsRepo.create({
        document: { id: documentId } as any,
        user: { id: userId } as any,
        action,
      }),
    );
  }
}
