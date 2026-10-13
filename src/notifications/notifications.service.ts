import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { createTransport, Transporter } from 'nodemailer';
import { Subject } from 'rxjs';
import { Notification, NotificationType } from '../entities/notification.entity';
import { User, UserRole } from '../entities/user.entity';

// ─── Event payload types ──────────────────────────────────────
export interface DocumentStatusEvent {
  documentId: string;
  documentTitle: string;
  uploaderId: string;
  uploaderEmail: string;
  uploaderName: string;
  actorName: string;
  rejectReason?: string;
}

export interface DocumentUploadedEvent {
  documentId: string;
  documentTitle: string;
  uploaderId: string;
  departmentId: string | null;
}

export interface RoleChangedEvent {
  targetUserId: string;
  targetEmail: string;
  targetName: string;
  oldRole: string;
  newRole: string;
}

export interface ViewRequestCreatedEvent {
  viewRequestId: string;
  documentId: string;
  documentTitle: string;
  requesterId: string;
  departmentId: string | null;
  reason: string;
}

export interface ViewRequestDecisionEvent {
  viewRequestId: string;
  documentId: string;
  documentTitle: string;
  requesterId: string;
  requesterEmail?: string;
  requesterName?: string;
  approverName: string;
  decisionNote?: string;
  accessExpiresAt?: Date;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private mailer: Transporter | null = null;

  // SSE: per-user Subject map  userId → Subject<MessageEvent>
  private readonly sseStreams = new Map<string, Subject<MessageEvent>>();

  constructor(
    @InjectRepository(Notification) private notiRepo: Repository<Notification>,
    @InjectRepository(User) private userRepo: Repository<User>,
  ) {
    this.initMailer();
  }

  private initMailer() {
    const host = process.env.SMTP_HOST;
    if (!host) {
      this.logger.warn('SMTP_HOST không được cấu hình — email sẽ bị bỏ qua');
      return;
    }
    this.mailer = createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // ─── SSE stream management ────────────────────────────────
  getStream(userId: string): Subject<MessageEvent> {
    if (!this.sseStreams.has(userId)) {
      this.sseStreams.set(userId, new Subject<MessageEvent>());
    }
    return this.sseStreams.get(userId)!;
  }

  removeStream(userId: string) {
    this.sseStreams.get(userId)?.complete();
    this.sseStreams.delete(userId);
  }

  private pushSse(userId: string, payload: object) {
    const stream = this.sseStreams.get(userId);
    if (stream) {
      stream.next({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }

  // ─── DB helpers ───────────────────────────────────────────
  private async saveAndPush(
    recipientId: string,
    type: NotificationType,
    title: string,
    message: string,
    documentId?: string,
  ) {
    const noti = this.notiRepo.create({
      recipient: { id: recipientId } as any,
      type,
      title,
      message,
      document: documentId ? ({ id: documentId } as any) : null,
    });
    const saved = await this.notiRepo.save(noti);
    this.pushSse(recipientId, { type, title, message, id: saved.id, createdAt: saved.createdAt });
    return saved;
  }

  private async sendEmail(to: string, subject: string, html: string) {
    if (!this.mailer) return;
    try {
      await this.mailer.sendMail({
        from: process.env.SMTP_FROM || 'LTHS Lưu Trữ <no-reply@lths.local>',
        to,
        subject,
        html,
      });
    } catch (err) {
      this.logger.error(`Gửi email thất bại tới ${to}: ${(err as Error).message}`);
    }
  }

  // ─── Event handlers ───────────────────────────────────────

  @OnEvent('document.approved')
  async onDocumentApproved(evt: DocumentStatusEvent) {
    const title = 'Tài liệu đã được duyệt';
    const message = `Tài liệu "${evt.documentTitle}" của bạn đã được ${evt.actorName} duyệt và lưu trữ.`;

    await this.saveAndPush(evt.uploaderId, NotificationType.DOCUMENT_APPROVED, title, message, evt.documentId);
    await this.sendEmail(
      evt.uploaderEmail,
      `[LTHS] ${title}`,
      `<p>Xin chào <strong>${evt.uploaderName}</strong>,</p>
       <p>${message}</p>
       <p>Trân trọng,<br>Hệ thống LTHS Lưu Trữ</p>`,
    );
  }

  @OnEvent('document.uploaded')
  async onDocumentUploaded(evt: DocumentUploadedEvent) {
    const recipients = await this.userRepo.find({
      where: [
        { role: UserRole.ADMIN },
        ...(evt.departmentId
          ? [{ role: UserRole.DEPARTMENT_HEAD, department: { id: evt.departmentId } }]
          : []),
      ],
    });
    const title = 'Có tài liệu mới chờ duyệt';
    const message = `Tài liệu "${evt.documentTitle}" vừa được tải lên và đang chờ duyệt.`;

    await Promise.all(
      recipients
        .filter((recipient) => recipient.id !== evt.uploaderId)
        .map((recipient) =>
          this.saveAndPush(
            recipient.id,
            NotificationType.DOCUMENT_PENDING,
            title,
            message,
            evt.documentId,
          ),
        ),
    );
  }

  @OnEvent('document.rejected')
  async onDocumentRejected(evt: DocumentStatusEvent) {
    const title = 'Tài liệu bị từ chối';
    const reasonLine = evt.rejectReason ? `<br><strong>Lý do:</strong> ${evt.rejectReason}` : '';
    const message = `Tài liệu "${evt.documentTitle}" bị từ chối bởi ${evt.actorName}.${evt.rejectReason ? ' Lý do: ' + evt.rejectReason : ''}`;

    await this.saveAndPush(evt.uploaderId, NotificationType.DOCUMENT_REJECTED, title, message, evt.documentId);
    await this.sendEmail(
      evt.uploaderEmail,
      `[LTHS] ${title}`,
      `<p>Xin chào <strong>${evt.uploaderName}</strong>,</p>
       <p>Tài liệu <strong>"${evt.documentTitle}"</strong> đã bị từ chối.${reasonLine}</p>
       <p>Trân trọng,<br>Hệ thống LTHS Lưu Trữ</p>`,
    );
  }

  @OnEvent('role.changed')
  async onRoleChanged(evt: RoleChangedEvent) {
    const roleLabel: Record<string, string> = {
      user: 'Người dùng', department_head: 'Trưởng Khoa', admin: 'Quản trị viên',
    };
    const title = 'Vai trò tài khoản đã thay đổi';
    const message = `Vai trò của bạn đã được cập nhật từ "${roleLabel[evt.oldRole] ?? evt.oldRole}" thành "${roleLabel[evt.newRole] ?? evt.newRole}".`;

    await this.saveAndPush(evt.targetUserId, NotificationType.ROLE_CHANGED, title, message);
    await this.sendEmail(
      evt.targetEmail,
      `[LTHS] ${title}`,
      `<p>Xin chào <strong>${evt.targetName}</strong>,</p>
       <p>${message}</p>
       <p>Trân trọng,<br>Hệ thống LTHS Lưu Trữ</p>`,
    );
  }

  // ─── API methods ──────────────────────────────────────────

  @OnEvent('view-request.created')
  async onViewRequestCreated(evt: ViewRequestCreatedEvent) {
    const requester = await this.userRepo.findOne({ where: { id: evt.requesterId } });
    const recipients = await this.userRepo.find({
      where: [
        { role: UserRole.ADMIN },
        ...(evt.departmentId
          ? [{ role: UserRole.DEPARTMENT_HEAD, department: { id: evt.departmentId } }]
          : []),
      ],
    });

    const title = 'Co yeu cau xem tai lieu moi';
    const requesterName = requester?.fullName ?? requester?.email ?? evt.requesterId;
    const message = `${requesterName} yeu cau xem tai lieu "${evt.documentTitle}".`;

    await Promise.all(
      recipients
        .filter((recipient) => recipient.id !== evt.requesterId)
        .map(async (recipient) => {
          await this.saveAndPush(
            recipient.id,
            NotificationType.VIEW_REQUEST_PENDING,
            title,
            message,
            evt.documentId,
          );
          await this.sendEmail(
            recipient.email,
            `[LTHS] ${title}`,
            `<p>${message}</p><p><strong>Ly do:</strong> ${evt.reason}</p>`,
          );
        }),
    );
  }

  @OnEvent('view-request.approved')
  async onViewRequestApproved(evt: ViewRequestDecisionEvent) {
    const title = 'Yeu cau xem tai lieu da duoc duyet';
    const message = `Yeu cau xem tai lieu "${evt.documentTitle}" cua ban da duoc duyet.`;

    await this.saveAndPush(
      evt.requesterId,
      NotificationType.VIEW_REQUEST_APPROVED,
      title,
      message,
      evt.documentId,
    );
    if (evt.requesterEmail) {
      await this.sendEmail(
        evt.requesterEmail,
        `[LTHS] ${title}`,
        `<p>Xin chao <strong>${evt.requesterName ?? ''}</strong>,</p>
         <p>${message}</p>
         <p>Han xem: ${evt.accessExpiresAt?.toISOString() ?? 'khong ro'}</p>`,
      );
    }
  }

  @OnEvent('view-request.rejected')
  async onViewRequestRejected(evt: ViewRequestDecisionEvent) {
    const title = 'Yeu cau xem tai lieu bi tu choi';
    const message = `Yeu cau xem tai lieu "${evt.documentTitle}" cua ban bi tu choi.${evt.decisionNote ? ' Ly do: ' + evt.decisionNote : ''}`;

    await this.saveAndPush(
      evt.requesterId,
      NotificationType.VIEW_REQUEST_REJECTED,
      title,
      message,
      evt.documentId,
    );
    if (evt.requesterEmail) {
      await this.sendEmail(
        evt.requesterEmail,
        `[LTHS] ${title}`,
        `<p>Xin chao <strong>${evt.requesterName ?? ''}</strong>,</p>
         <p>${message}</p>`,
      );
    }
  }

  getMyNotifications(userId: string, unreadOnly = false) {
    const qb = this.notiRepo
      .createQueryBuilder('noti')
      .leftJoinAndSelect('noti.document', 'doc')
      .where('noti.recipient_id = :userId', { userId })
      .orderBy('noti.createdAt', 'DESC')
      .limit(50);

    if (unreadOnly) qb.andWhere('noti.is_read = false');
    return qb.getMany();
  }

  async markRead(id: string, userId: string): Promise<void> {
    await this.notiRepo.update(
      { id, recipient: { id: userId } },
      { isRead: true },
    );
  }

  async markAllRead(userId: string): Promise<void> {
    await this.notiRepo.update(
      { recipient: { id: userId }, isRead: false },
      { isRead: true },
    );
  }

  countUnread(userId: string): Promise<number> {
    return this.notiRepo.count({
      where: { recipient: { id: userId }, isRead: false },
    });
  }
}
