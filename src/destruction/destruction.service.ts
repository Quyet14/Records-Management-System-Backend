import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { randomUUID, randomInt, timingSafeEqual } from 'crypto';
import { Document, DocumentStatus } from '../entities/document.entity';
import { User, UserRole } from '../entities/user.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { DestructionApproval as Approval, DestructionAttachment as Attachment, DestructionItem as Item,
  DestructionJob as Job, DestructionOtpChallenge as Challenge, DestructionRequest as Request,
  DestructionIdempotency as Idempotency, DestructionBackupDisposition as Disposition } from '../entities/destruction.entity';
import { DestructionAttachmentContent as AttachmentContent } from '../entities/destruction.entity';
import { Actor, actions, approvalsValid, canApprove, digest, documentScope, eligible, eligibilityReasons, fail, matchVersion, MAX_ITEMS, MAX_PDF_BYTES,
  pagination, requiredApprovals, requester, text, WAIT_HOURS, WAIT_MS } from './destruction.rules';
import { DestructionInfrastructure } from './destruction.infrastructure';
import { parseDocumentSecurityLevel } from '../common/document-security';
import { normalizeUploadFilename } from '../common/upload-filename';

@Injectable()
export class DestructionService {
  constructor(private readonly db: DataSource, readonly infrastructure: DestructionInfrastructure) {}

  async now(manager: EntityManager = this.db.manager): Promise<Date> {
    const [row] = await manager.query('SELECT UTC_TIMESTAMP(3) AS server_now');
    const value = row.server_now;
    return value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + 'Z');
  }

  async capabilities(actor: Actor) {
    const health = await this.infrastructure.health();
    return { enabled: !!health, canCreate: !!health && requester(actor), serverTime: (await this.now()).toISOString(),
      waitHours: WAIT_HOURS, maxPdfBytes: MAX_PDF_BYTES, maxItemsPerRequest: MAX_ITEMS, backupPolicy: health?.backupPolicy ?? null,
      provider: this.infrastructure.provider(), unavailableReasons: health ? [] : await this.infrastructure.unavailableReasons() };
  }

  private assertRequester(actor: Actor) {
    if (!requester(actor)) fail(403, 'FORBIDDEN', 'Bạn không có quyền gửi yêu cầu hủy hồ sơ hoặc chưa được phân khoa.');
  }

  private async actor(manager: EntityManager, id: string, lock = false): Promise<Actor> {
    const user = await manager.findOne(User, { where: { id }, relations: ['department'],
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!user?.isActive) fail(401, 'UNAUTHORIZED', 'Tài khoản không hoạt động.');
    return { id, role: user.role, departmentId: user.department?.id, permissions: user.permissions ?? [] };
  }

  async documents(manager: EntityManager, ids: string[], lock = false): Promise<Document[]> {
    const result: Document[] = [];
    for (const id of [...ids].sort()) {
      const doc = await manager.findOne(Document, { where: { id }, relations: ['department', 'documentType', 'uploader', 'file'],
        ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
      if (!doc) fail(404, 'NOT_FOUND', 'Không tìm thấy hồ sơ.');
      result.push(doc);
    }
    return result;
  }

  private async requestDocuments(manager: EntityManager, id: string): Promise<Document[]> {
    const items = await manager.find(Item, { where: { requestId: id } });
    return this.documents(manager, items.map(item => item.documentId));
  }

  async approvalReviewers(manager: EntityManager, approvals: Approval[]): Promise<Actor[]> {
    const reviewers: Actor[] = [];
    for (const approval of approvals) {
      const user = await manager.findOne(User, { where: { id: approval.userId }, relations: ['department'] });
      if (user?.isActive) reviewers.push({ id: user.id, role: user.role, departmentId: user.department?.id });
    }
    return reviewers;
  }

  async request(manager: EntityManager, id: string, actor: Actor, lock = false): Promise<Request> {
    this.assertRequester(actor);
    const request = await manager.findOne(Request, { where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!request) fail(404, 'NOT_FOUND', 'Không tìm thấy đề nghị.');
    if (actor.role === UserRole.USER && request.createdBy !== actor.id)
      fail(404, 'NOT_FOUND', 'Không tìm thấy đề nghị.');
    if (actor.role !== UserRole.ADMIN) {
      const docs = await this.requestDocuments(manager, id);
      if (!docs.length || !docs.every(doc => documentScope(doc, actor))) fail(404, 'NOT_FOUND', 'Không tìm thấy đề nghị.');
    }
    return request;
  }

  snapshot(doc: Document) {
    return { title: doc.title || doc.originalFilename, code: doc.documentNumber || doc.referenceNo || doc.id,
      sizeBytes: Number(doc.fileSizeBytes), checksum: doc.sha256Checksum, version: doc.version,
      fileId: doc.file?.id ?? null, storagePath: doc.storagePath, securityLevel: doc.securityLevel,
      departmentId: doc.department?.id ?? null, documentTypeId: doc.documentType?.id ?? null,
      classificationValue: doc.classificationValue, retentionUntil: doc.retentionUntil,
      typePolicy: doc.documentType ? { isPermanent: doc.documentType.isPermanent, retentionBasis: doc.documentType.retentionBasis,
        retentionYears: doc.documentType.retentionYears } : null };
  }

  async checkItems(manager: EntityManager, request: Request, now: Date, skipDestroyed = false) {
    const items = await manager.find(Item, { where: { requestId: request.id }, order: { documentId: 'ASC' } });
    if (!items.length) fail(409, 'EMPTY_REQUEST', 'Đề nghị không có hồ sơ hợp lệ.');
    const docs = await this.documents(manager, items.map(item => item.documentId), true);
    for (const doc of docs) {
      const item = items.find(i => i.documentId === doc.id)!;
      if (skipDestroyed && item.status === 'destroyed' && doc.status === DocumentStatus.DESTROYED) continue;
      if (!eligible(doc, now, request.id) || digest(this.snapshot(doc)) !== digest(item.snapshot))
        fail(409, 'DOCUMENT_CHANGED', 'Điều kiện hoặc nội dung hồ sơ đã thay đổi. Cần kiểm tra lại.');
    }
    if (requiredApprovals(docs) !== request.requiredApprovals) fail(409, 'POLICY_CHANGED', 'Chính sách duyệt đã thay đổi.');
    return { items, docs };
  }

  async audit(manager: EntityManager, actorId: string | null, request: Request, description: string, oldStatus: string | null, result = 'success') {
    await manager.save(AuditLog, manager.create(AuditLog, { actor: actorId ? { id: actorId } : undefined,
      action: 'destruction', createdAt: await this.now(manager), metadata: { requestId: request.id, description, oldStatus, newStatus: request.status,
        digest: request.digest, version: request.version, result } }));
  }

  private async mutation(actor: Actor, endpoint: string, key: string | undefined, payload: any,
    operation: (m: EntityManager, actor: Actor, now: Date) => Promise<any>) {
    if (!key || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) fail(422, 'IDEMPOTENCY_KEY_REQUIRED', 'Thiếu Idempotency-Key hợp lệ.');
    const id = digest([actor.id, endpoint, key]);
    const payloadDigest = digest(payload);
    // The current actor row serializes concurrent keys without persisting an incomplete result.
    return this.infrastructure.guardMutation(() => this.db.transaction('READ COMMITTED', async manager => {
      const current = await this.actor(manager, actor.id, true);
      this.assertRequester(current);
      const prior = await manager.findOneBy(Idempotency, { id });
      if (prior) {
        if (prior.digest !== payloadDigest) fail(409, 'IDEMPOTENCY_CONFLICT', 'Khóa gửi lại đã được dùng với nội dung khác.');
        // Enforce current object visibility even on a replay.
        if (prior.result.id) await this.request(manager, prior.result.id, current);
        return prior.result;
      }
      const now = await this.now(manager);
      const result = await operation(manager, current, now);
      if (!result.otpFailure) await manager.insert(Idempotency, { id, digest: payloadDigest, result, createdAt: now });
      return result;
    })).catch(error => {
      if ([1062, 1205, 1213].includes(error?.driverError?.errno))
        fail(409, 'CONCURRENT_CHANGE', 'Dữ liệu đang được xử lý đồng thời. Vui lòng tải lại và gửi lại cùng khóa.');
      throw error;
    });
  }

  async eligibleDocuments(query: any, actor: Actor) {
    this.assertRequester(actor);
    const { page, pageSize } = pagination(query);
    const qb = this.db.getRepository(Document).createQueryBuilder('doc')
      .leftJoinAndSelect('doc.documentType', 'dt').leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .where('doc.status IN (:...statuses)', { statuses: ['stored', 'approved'] })
      .andWhere('doc.classificationValue = :classification', { classification: 'timed' })
      .andWhere('dt.isPermanent = false AND dt.retentionBasis IN (:...bases)', { bases: ['document_date', 'patient_death_date'] })
      .andWhere('dt.retentionYears > 0')
      .andWhere('doc.retentionUntil IS NOT NULL AND doc.legalHold = false')
      .andWhere('doc.destructionRequestId IS NULL AND doc.destroyedAt IS NULL');
    if (actor.role !== UserRole.ADMIN) qb.andWhere('department.id = :department', { department: actor.departmentId });
    if (actor.role === UserRole.USER) qb.andWhere('uploader.id = :uploader', { uploader: actor.id });
    if (query.q) qb.andWhere('(doc.title LIKE :q OR doc.documentNumber LIKE :q OR doc.referenceNo LIKE :q OR dt.name LIKE :q)', { q: `%${text(query.q, 200)}%` });
    const [docs, total] = await qb.orderBy('doc.id', 'ASC').skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return { items: docs.map(doc => ({ id: doc.id, code: doc.documentNumber || doc.referenceNo || doc.id,
      title: doc.title || doc.originalFilename, documentType: { id: doc.documentType.id, name: doc.documentType.name },
      status: doc.status, securityLevel: parseDocumentSecurityLevel(doc.securityLevel) ?? 'top_secret', retentionUntil: doc.retentionUntil,
      legalHold: false, activeDestructionRequestId: null, eligible: true })), page, pageSize, total };
  }

  private async attachment(manager: EntityManager, requestId: string, actor: Actor, type: string, file: Express.Multer.File,
    identity: string, now: Date) {
    await this.infrastructure.validatePdf(file);
    const sha256 = (await import('crypto')).createHash('sha256').update(file.buffer).digest('hex');
    const objectKey = digest([requestId, actor.id, identity, type, sha256]);
    const filename = normalizeUploadFilename(file.originalname);
    const attachment = await manager.save(Attachment, manager.create(Attachment, { id: randomUUID(), requestId, type, filename, objectKey,
      size: file.buffer.length, sha256, uploadedBy: actor.id, createdAt: now, signatureValidationResult: { status: 'not_checked' } }));
    // Evidence bytes commit with the request, snapshots, audit and replay result. No orphan upload saga.
    await manager.save(AttachmentContent, manager.create(AttachmentContent, { attachmentId: attachment.id, bytes: file.buffer }));
    return attachment;
  }

  async create(body: any, files: any, actor: Actor, key?: string) {
    this.assertRequester(actor);
    let ids: any;
    try { ids = JSON.parse(body.documentIds); } catch { fail(422, 'INVALID_DOCUMENTS', 'Danh sách hồ sơ không hợp lệ.'); }
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ITEMS || new Set(ids).size !== ids.length
      || !ids.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) fail(422, 'INVALID_DOCUMENTS', 'Danh sách hồ sơ không hợp lệ.');
    const reason = text(body.reason), decisionNumber = text(body.decisionNumber, 100), decisionDate = text(body.decisionDate, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(decisionDate) || !Number.isFinite(Date.parse(decisionDate))
      || new Date(decisionDate).toISOString().slice(0, 10) !== decisionDate) fail(422, 'INVALID_DATE', 'Ngày quyết định không hợp lệ.');
    if (body.signedDocumentConfirmed !== 'true') fail(422, 'CONFIRMATION_REQUIRED', 'Cần xác nhận chứng từ đã ký.');
    const fileDigest = Object.keys(files ?? {}).sort().map(type => [type, digest(files[type][0].buffer)]);
    return this.mutation(actor, 'create', key, [body, fileDigest], async (manager, current, now) => {
      const health = await this.infrastructure.requireReady();
      if (body.backupPolicyVersion !== health.backupPolicy.version) fail(409, 'POLICY_CHANGED', 'Chính sách backup đã thay đổi.');
      const docs = await this.documents(manager, ids, true);
      if (!docs.every(doc => documentScope(doc, current))) fail(404, 'NOT_FOUND', 'Không tìm thấy hồ sơ trong phạm vi cho phép.');
      if (requiredApprovals(docs) === 2 && (!docs[0]?.department?.id
        || docs.some(doc => doc.department?.id !== docs[0].department.id)))
        fail(422, 'DEPARTMENT_REVIEW_REQUIRED', 'Đề nghị có hồ sơ mật phải thuộc cùng một khoa để Trưởng khoa và Admin duyệt. Hãy lập đề nghị riêng theo khoa.');
      if (docs.some(doc => doc.destructionRequestId)) fail(409, 'DOCUMENT_ALREADY_CLAIMED', 'Hồ sơ đang thuộc một đề nghị hủy khác.');
      for (const doc of docs) {
        const reasons = eligibilityReasons(doc);
        if (!/^[a-f0-9]{64}$/i.test(doc.sha256Checksum || '')) reasons.push('thiếu hoặc sai mã kiểm tra SHA-256 của file');
        if (!(Number(doc.fileSizeBytes) >= 0)) reasons.push('dung lượng file không hợp lệ');
        if (reasons.length) {
          const label = (doc.title || doc.originalFilename || doc.id).slice(0, 120);
          fail(422, 'INELIGIBLE_DOCUMENT', `Hồ sơ "${label}" (${doc.id}) chưa đủ điều kiện: ${reasons.join('; ')}.`);
        }
      }
      const id = randomUUID();
      // Insert parent first for FK; every following write and attachment metadata is in this transaction.
      const request = manager.create(Request, { id, code: `HUY-${now.getUTCFullYear()}-${id}`, reason, decisionNumber, decisionDate,
        status: 'pending', createdBy: current.id, createdAt: now, requiredApprovals: requiredApprovals(docs),
        version: 1, backupPolicy: health.backupPolicy, digest: '0'.repeat(64) });
      await manager.insert(Request, request);
      const attachments: Attachment[] = [];
      attachments.push(await this.attachment(manager, id, current, 'decision', files?.decisionFile?.[0], key!, now));
      if (files?.councilMinutesFile?.[0]) attachments.push(await this.attachment(manager, id, current, 'council_minutes', files.councilMinutesFile[0], key!, now));
      const snapshots = docs.map(doc => ({ documentId: doc.id, ...this.snapshot(doc) }));
      request.digest = digest([snapshots, attachments.map(a => ({ type: a.type, sha256: a.sha256 })), reason, decisionNumber, decisionDate, health.backupPolicy]);
      for (const doc of docs) {
        await manager.save(Item, manager.create(Item, { id: randomUUID(), requestId: id, documentId: doc.id, snapshot: this.snapshot(doc), status: 'pending' }));
        await manager.update(Document, doc.id, { destructionRequestId: id });
      }
      await manager.save(Request, request);
      await this.audit(manager, current.id, request, 'Đã nộp đề nghị và chứng từ hủy hồ sơ', null);
      return { id, code: request.code, status: request.status, version: request.version };
    });
  }

  async list(query: any, actor: Actor) {
    this.assertRequester(actor);
    const { page, pageSize } = pagination(query);
    const qb = this.db.getRepository(Request).createQueryBuilder('r');
    if (actor.role === UserRole.USER) {
      qb.andWhere('r.createdBy = :creator', { creator: actor.id });
      qb.andWhere(`NOT EXISTS (SELECT 1 FROM destruction_items i JOIN documents d ON d.id = i.document_id
        WHERE i.request_id = r.id AND (d.uploader_id IS NULL OR d.uploader_id != :uploader))`, { uploader: actor.id });
    }
    if (actor.role !== UserRole.ADMIN) {
      // Department heads review sensitive destruction requests for their own department.
      qb.andWhere(`NOT EXISTS (SELECT 1 FROM destruction_items i JOIN documents d ON d.id = i.document_id
        WHERE i.request_id = r.id AND (d.department_id IS NULL OR d.department_id != :department))`,
      { department: actor.departmentId });
    }
    if (query.status) qb.andWhere('r.status = :status', { status: text(query.status, 32) });
    const [requests, total] = await qb.orderBy('r.createdAt', 'DESC').addOrderBy('r.id', 'ASC')
      .skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    if (!requests.length) return { items: [], page, pageSize, total };
    // Fetch names and approval totals for the current page, not two queries per row.
    const [creators, approvalCounts] = await Promise.all([
      this.db.manager.find(User, { where: { id: In([...new Set(requests.map(r => r.createdBy))]) }, select: { id: true, fullName: true } }),
      this.db.getRepository(Approval).createQueryBuilder('a').select('a.requestId', 'requestId')
        .addSelect('COUNT(*)', 'count').where('a.requestId IN (:...requestIds)', { requestIds: requests.map(r => r.id) })
        .groupBy('a.requestId').getRawMany<{ requestId: string; count: string }>(),
    ]);
    const names = new Map(creators.map(user => [user.id, user.fullName]));
    const counts = new Map(approvalCounts.map(row => [row.requestId, Number(row.count)]));
    const items = requests.map(request => ({ id: request.id, code: request.code, decisionNumber: request.decisionNumber,
      createdBy: { id: request.createdBy, fullName: names.get(request.createdBy) ?? '' },
      status: request.status, approvalCount: counts.get(request.id) ?? 0,
      requiredApprovals: request.requiredApprovals, executeAfter: request.executeAfter }));
    return { items, page, pageSize, total };
  }

  async detail(id: string, actor: Actor) {
    const m = this.db.manager;
    const request = await this.request(m, id, actor);
    const approvals = await m.findBy(Approval, { requestId: id });
    const named = async (userId: string) => ({ id: userId, fullName: (await m.findOneBy(User, { id: userId }))?.fullName ?? '' });
    const attachments = await m.findBy(Attachment, { requestId: id });
    const events = await m.getRepository(AuditLog).createQueryBuilder('a').leftJoinAndSelect('a.actor', 'actor')
      .where("JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.requestId')) = :id", { id }).orderBy('a.createdAt', 'ASC').getMany();
    const items = await m.findBy(Item, { requestId: id });
    const dispositions = await m.findBy(Disposition, { requestId: id });
    const { digest: ignored, ...view } = request;
    return { ...view, createdBy: await named(request.createdBy), allowedActions: actions(request, actor, approvals, await this.now(), await this.requestDocuments(m, id), await this.approvalReviewers(m, approvals)),
      approvals: await Promise.all(approvals.map(async a => ({ userId: a.userId, fullName: (await named(a.userId)).fullName, approvedAt: a.approvedAt }))),
      items: items.map(i => ({ documentId: i.documentId, title: i.snapshot.title, code: i.snapshot.code, sizeBytes: i.snapshot.sizeBytes,
        checksum: i.snapshot.checksum, checksumAtDestruction: i.checksumAtDestruction, status: i.status, destroyedAt: i.destroyedAt })),
      attachments: await Promise.all(attachments.map(async a => ({ id: a.id, type: a.type, filename: a.filename, originalFilename: a.filename, sha256: a.sha256,
        uploadedBy: await named(a.uploadedBy), createdAt: a.createdAt, signatureValidationResult: a.signatureValidationResult }))),
      backupDispositions: [
        ...dispositions.map(d => ({ documentId: d.documentId, label: request.backupPolicy.targets.find(t => t.key === d.target)?.label,
          status: d.status, purgeDueAt: d.purgeDueAt, purgedAt: d.purgedAt })),
        ...items.flatMap(item => request.backupPolicy.targets.filter(t => t.enabled === false).map(t => ({
          documentId: item.documentId, label: t.label, status: 'not_used', notes: t.notes, purgeDueAt: null, purgedAt: null,
        }))),
      ],
      events: events.map(e => ({ createdAt: e.createdAt, actorName: e.actor?.fullName ?? 'Hệ thống', description: e.metadata?.description ?? 'Cập nhật hồ sơ' })) };
  }

  async content(id: string, attachmentId: string, actor: Actor) {
    await this.request(this.db.manager, id, actor);
    const attachment = await this.db.manager.findOneBy(Attachment, { id: attachmentId, requestId: id });
    if (!attachment) fail(404, 'NOT_FOUND', 'Không tìm thấy chứng từ.');
    const content = await this.db.manager.findOne(AttachmentContent, { where: { attachmentId }, select: { attachmentId: true, bytes: true } });
    if (!content) fail(503, 'EVIDENCE_UNAVAILABLE', 'Chứng từ chưa sẵn sàng.');
    const bytes = Buffer.from(content.bytes);
    if (bytes.length !== attachment.size || (await import('crypto')).createHash('sha256').update(bytes).digest('hex') !== attachment.sha256)
      fail(503, 'EVIDENCE_INTEGRITY_ERROR', 'Không thể xác nhận tính toàn vẹn chứng từ.');
    return { bytes, filename: attachment.filename };
  }

  async challenge(id: string, body: any, version: string | undefined, actor: Actor) {
    await this.infrastructure.requireReady();
    if (body.purpose !== 'approve') fail(422, 'INVALID_PURPOSE', 'Mục đích OTP không hợp lệ.');
    return this.infrastructure.guardMutation(() => this.db.transaction('READ COMMITTED', async m => {
      const current = await this.actor(m, actor.id, true);
      const r = await this.request(m, id, current, true);
      matchVersion(version, r.version);
      const approvals = await m.findBy(Approval, { requestId: id });
      if (!canApprove(r, current, approvals, await this.requestDocuments(m, id), await this.approvalReviewers(m, approvals)))
        fail(403, 'FORBIDDEN', current.id === r.createdBy ? 'Người lập không được tự duyệt đề nghị hủy của mình. Cần một người duyệt khác.' : 'Bạn không có quyền duyệt đề nghị này hoặc đã duyệt trước đó.');
      const now = await this.now(m);
      const recent = await m.getRepository(Challenge).createQueryBuilder('c').where('c.actorId = :actor', { actor: current.id })
        .andWhere('c.createdAt > :cutoff', { cutoff: new Date(now.getTime() - 3600000) }).orderBy('c.createdAt', 'DESC').getMany();
      if (recent.length >= 10 || (recent[0] && now.getTime() - recent[0].createdAt.getTime() < 60000))
        fail(429, 'OTP_RATE_LIMIT', 'Vui lòng chờ trước khi yêu cầu mã OTP tiếp theo.');
      const challengeId = randomUUID(), otp = String(randomInt(0, 1000000)).padStart(6, '0');
      const expiresAt = new Date(now.getTime() + 5 * 60000);
      await m.insert(Challenge, { id: challengeId, requestId: id, actorId: current.id, purpose: 'approve', boundVersion: r.version,
        boundDigest: r.digest, verifierHash: this.infrastructure.otpHash(challengeId, otp), createdAt: now, expiresAt, attemptCount: 0 });
      const delivered = await this.infrastructure.call('otp/deliver', { actorId: current.id, challengeId, otp, expiresAt });
      if (delivered.delivered !== true) fail(503, 'OTP_UNAVAILABLE', 'Không thể gửi mã OTP qua kênh đã đăng ký.');
      return { challengeId, expiresAt, message: 'Nhập mã OTP được gửi qua kênh xác thực đã đăng ký của bạn.' };
    }));
  }

  async approve(id: string, body: any, version: string | undefined, key: string | undefined, actor: Actor) {
    // Do not include a low-entropy OTP in persisted idempotency digests.
    const payload = { challengeId: body.challengeId, documentsReviewed: body.documentsReviewed,
      verifier: this.infrastructure.otpHash(String(body.challengeId), String(body.otp)) };
    const result = await this.mutation(actor, `${id}/approve`, key, payload, async (m, current, now) => {
      const r = await this.request(m, id, current, true);
      matchVersion(version, r.version);
      const approvals = await m.findBy(Approval, { requestId: id });
      if (!canApprove(r, current, approvals, await this.requestDocuments(m, id), await this.approvalReviewers(m, approvals)))
        fail(403, 'FORBIDDEN', current.id === r.createdBy ? 'Người lập không được tự duyệt đề nghị hủy của mình. Cần một người duyệt khác.' : 'Bạn không có quyền duyệt hoặc đã duyệt đề nghị này.');
      if (body.documentsReviewed !== true) fail(422, 'REVIEW_REQUIRED', 'Cần xác nhận đã xem chứng từ.');
      const health = await this.infrastructure.requireReady();
      if (digest(health.backupPolicy) !== digest(r.backupPolicy)) fail(409, 'POLICY_CHANGED', 'Chính sách backup đã thay đổi.');
      const { docs } = await this.checkItems(m, r, now);
      const challenge = typeof body.challengeId === 'string' ? await m.findOne(Challenge, { where: { id: body.challengeId }, lock: { mode: 'pessimistic_write' } }) : null;
      if (!challenge || challenge.actorId !== current.id || challenge.requestId !== id || challenge.purpose !== 'approve'
        || challenge.boundVersion !== r.version || challenge.boundDigest !== r.digest || challenge.consumedAt
        || challenge.expiresAt <= now || challenge.attemptCount >= 5) fail(422, 'INVALID_OTP', 'Mã OTP không hợp lệ hoặc đã hết hạn.');
      challenge.attemptCount++;
      if (!/^\d{6,8}$/.test(body.otp ?? '') || !timingSafeEqual(Buffer.from(challenge.verifierHash, 'hex'), Buffer.from(payload.verifier, 'hex'))) {
        await m.save(Challenge, challenge);
        await this.audit(m, current.id, r, 'Xác thực OTP không thành công', r.status, 'failure');
        // Return a failure sentinel so the attempt counter commits; never persist a success/replay for it.
        return { otpFailure: true };
      }
      challenge.consumedAt = now;
      await m.save(Challenge, challenge);
      await m.insert(Approval, { id: randomUUID(), requestId: id, userId: current.id, approvedAt: now,
        version: r.version, digest: r.digest, otpChallengeId: challenge.id });
      const allApprovals = await m.findBy(Approval, { requestId: id });
      if (allApprovals.length >= r.requiredApprovals
        && !approvalsValid(r, docs, allApprovals, await this.approvalReviewers(m, allApprovals)))
        fail(409, 'INVALID_APPROVALS', 'Hồ sơ mật cần một Trưởng khoa của hồ sơ và một Admin duyệt.');
      const old = r.status;
      r.version++;
      r.status = approvals.length + 1 >= r.requiredApprovals ? 'scheduled' : 'partially_approved';
      r.executeAfter = r.status === 'scheduled' ? new Date(now.getTime() + WAIT_MS) : null;
      await m.save(Request, r);
      if (r.executeAfter) {
        const job = await m.findOne(Job, { where: { requestId: id }, lock: { mode: 'pessimistic_write' } });
        if (job) {
          // An operator may reopen a failed, unprepared request for genuine OTP approval.
          // Preserve attempt history; never reuse a job with deletion progress or a live lease.
          if (job.status !== 'cancelled' || job.checkpoint || job.leaseOwner || job.leaseExpiry)
            fail(409, 'DESTRUCTION_JOB_CONFLICT', 'Công việc hủy cũ chưa đủ điều kiện lập lịch lại.');
          job.status = 'scheduled'; job.runAt = r.executeAfter; job.lastError = null;
          await m.save(Job, job);
        } else await m.insert(Job, { requestId: id, runAt: r.executeAfter, status: 'scheduled', attempts: 0 });
      }
      await this.audit(m, current.id, r, 'Đã duyệt đề nghị bằng OTP', old);
      return { id, status: r.status, version: r.version, executeAfter: r.executeAfter };
    });
    if (result.otpFailure) fail(422, 'INVALID_OTP', 'Mã OTP không hợp lệ.');
    return result;
  }

  async transition(id: string, action: 'reject' | 'withdraw', body: any, version: string | undefined, key: string | undefined, actor: Actor) {
    const reason = text(body.reason);
    return this.mutation(actor, `${id}/${action}`, key, { reason }, async (m, current, now) => {
      const r = await this.request(m, id, current, true);
      matchVersion(version, r.version);
      if (!actions(r, current, await m.findBy(Approval, { requestId: id }), now, await this.requestDocuments(m, id)).includes(action))
        fail(409, 'ACTION_UNAVAILABLE', 'Không thể thực hiện thao tác ở trạng thái hoặc quyền hiện tại.');
      const old = r.status;
      r.status = action === 'reject' ? 'rejected' : 'withdrawn'; r.version++;
      await m.save(Request, r);
      await m.update(Job, { requestId: id }, { status: 'cancelled' });
      const items = await m.findBy(Item, { requestId: id });
      await this.documents(m, items.map(i => i.documentId), true);
      for (const item of items) await m.update(Document, { id: item.documentId, destructionRequestId: id }, { destructionRequestId: null });
      await this.audit(m, current.id, r, `${action === 'reject' ? 'Đã từ chối' : 'Đã thu hồi'}: ${reason}`, old);
      return { id, status: r.status, version: r.version, executeAfter: r.executeAfter };
    });
  }

  async complete(id: string, body: any, files: any, version: string | undefined, key: string | undefined, actor: Actor) {
    if (body.signedDocumentConfirmed !== 'true') fail(422, 'CONFIRMATION_REQUIRED', 'Cần xác nhận biên bản đã ký.');
    const notes = text(body.backupDispositionNotes);
    return this.mutation(actor, `${id}/complete`, key, [body, files?.destructionMinutesFile?.[0]?.buffer ? digest(files.destructionMinutesFile[0].buffer) : null], async (m, current, now) => {
      const r = await this.request(m, id, current, true);
      matchVersion(version, r.version);
      if (current.role !== UserRole.ADMIN || r.status !== 'destroyed') fail(409, 'ACTION_UNAVAILABLE', 'Chỉ được đóng khi hồ sơ đã được xác nhận hủy.');
      const items = await m.findBy(Item, { requestId: id });
      if (!items.length || items.some(i => i.status !== 'destroyed' || !i.destroyedAt || !i.checksumAtDestruction))
        fail(409, 'DESTRUCTION_UNCONFIRMED', 'Chưa xác nhận xóa hết nội dung hồ sơ.');
      await this.attachment(m, id, current, 'destruction_minutes', files?.destructionMinutesFile?.[0], key!, now);
      r.status = 'completed'; r.version++; r.completedAt = now; r.completedBy = current.id; r.backupDispositionNotes = notes;
      await m.save(Request, r);
      await this.audit(m, current.id, r, 'Đã nộp biên bản và đóng thủ tục hủy hồ sơ', 'destroyed');
      return { id, status: r.status, version: r.version };
    });
  }

  async destroyedDocuments(query: any, actor: Actor) {
    this.assertRequester(actor);
    const { page, pageSize } = pagination(query);
    const qb = this.db.getRepository(Document).createQueryBuilder('doc').leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.uploader', 'uploader').where('doc.status = :status', { status: 'destroyed' });
    if (actor.role !== UserRole.ADMIN) qb.andWhere('department.id = :department', { department: actor.departmentId });
    if (actor.role === UserRole.USER) qb.andWhere('uploader.id = :uploader', { uploader: actor.id });
    if (query.q) qb.andWhere('(doc.title LIKE :q OR doc.documentNumber LIKE :q OR doc.referenceNo LIKE :q)', { q: `%${text(query.q, 200)}%` });
    const [docs, total] = await qb.orderBy('doc.destroyedAt', 'DESC').addOrderBy('doc.id', 'ASC').skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    const items = [] as any[];
    for (const doc of docs) {
      const request = await this.db.manager.findOneBy(Request, { id: doc.destructionRequestId! });
      const item = await this.db.manager.findOneBy(Item, { requestId: request!.id, documentId: doc.id });
      const approvals = await this.db.manager.findBy(Approval, { requestId: request!.id });
      const approvers = await Promise.all(approvals.map(async a => ({ id: a.userId, fullName: (await this.db.manager.findOneBy(User, { id: a.userId }))?.fullName ?? '' })));
      items.push({ id: doc.id, code: item!.snapshot.code, title: item!.snapshot.title, sizeBytes: item!.snapshot.sizeBytes,
        checksumAtDestruction: item!.checksumAtDestruction, decisionNumber: request!.decisionNumber, approvers,
        destroyedAt: doc.destroyedAt, requestId: request!.id });
    }
    return { items, page, pageSize, total };
  }
}
