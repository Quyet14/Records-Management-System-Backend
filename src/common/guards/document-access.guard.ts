import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Document, DocumentStatus } from '../../entities/document.entity';
import { UserRole } from '../../entities/user.entity';
import { canReviewDocument, canViewDepartmentDocument } from '../document-permissions';
import { assertDocumentSecurityAccess } from '../document-security';
import {
  ViewRequest,
  ViewRequestStatus,
} from '../../entities/view-request.entity';

@Injectable()
export class DocumentAccessGuard implements CanActivate {
  constructor(
    @InjectRepository(Document) private docsRepo: Repository<Document>,
    @InjectRepository(ViewRequest)
    private viewRequestsRepo: Repository<ViewRequest>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    const documentId = req.params.id;

    if (!user?.id || !documentId) {
      throw new ForbiddenException('Khong co quyen truy cap tai lieu nay');
    }

    const doc = await this.docsRepo.findOne({
      where: { id: documentId },
      relations: ['department', 'uploader', 'file'],
    });
    if (!doc) throw new NotFoundException('Khong tim thay tai lieu');
    assertDocumentSecurityAccess(doc, user);

    const isOwner = doc.uploader?.id === user.id;
    if (isOwner) {
      req.documentForView = doc;
      return true;
    }

    if (doc.status === DocumentStatus.PENDING && canReviewDocument(doc, user)) {
      req.documentForView = doc;
      return true;
    }

    const isPublished =
      doc.status === DocumentStatus.STORED ||
      doc.status === DocumentStatus.APPROVED;
    if (!isPublished) {
      throw new ForbiddenException('Tai lieu chua duoc duyet/luu tru chinh thuc');
    }

    if (user.role === UserRole.ADMIN) {
      req.documentForView = doc;
      return true;
    }

    if (
      user.role === UserRole.DEPARTMENT_HEAD &&
      doc.department?.id &&
      doc.department.id === user.departmentId
    ) {
      req.documentForView = doc;
      return true;
    }

    if (canViewDepartmentDocument(doc, user)) {
      req.documentForView = doc;
      return true;
    }

    const approvedRequest = await this.viewRequestsRepo
      .createQueryBuilder('vr')
      .where('vr.document_id = :documentId', { documentId })
      .andWhere('vr.requester_id = :requesterId', { requesterId: user.id })
      .andWhere('vr.status = :approvedStatus', {
        approvedStatus: ViewRequestStatus.APPROVED,
      })
      .andWhere(
        new Brackets((qb) => {
          qb.where('vr.access_expires_at > :now', { now: new Date() }).orWhere(
            `EXISTS (
              SELECT 1
              FROM view_requests pending
              WHERE pending.extended_from_request_id = vr.id
                AND pending.status = :pendingStatus
            )`,
            { pendingStatus: ViewRequestStatus.PENDING },
          );
        }),
      )
      .getOne();

    if (!approvedRequest) {
      throw new ForbiddenException('Ban can co yeu cau xem da duoc duyet va con han');
    }

    req.documentForView = doc;
    return true;
  }
}
