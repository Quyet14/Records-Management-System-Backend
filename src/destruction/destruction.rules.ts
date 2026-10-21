import { HttpException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Document, DocumentStatus, ClassificationValue } from '../entities/document.entity';
import { UserPermission, UserRole } from '../entities/user.entity';
import { parseDocumentSecurityLevel } from '../common/document-security';

export interface Actor { id: string; role: UserRole; departmentId?: string; permissions?: UserPermission[] }
export const WAIT_HOURS = 24;
export const WAIT_MS = WAIT_HOURS * 60 * 60 * 1000;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_ITEMS = 100;
export function fail(status: number, code: string, message: string): never {
  throw new HttpException({ code, message }, status);
}
export function digest(value: unknown): string {
  // MySQL JSON normalizes object key order; canonicalize before binding approvals or comparing snapshots.
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(sort(JSON.parse(JSON.stringify(value))))).digest('hex');
}
export function staff(actor: Actor): boolean {
  return actor.role === UserRole.ADMIN || (actor.role === UserRole.DEPARTMENT_HEAD && !!actor.departmentId);
}
export function requester(actor: Actor): boolean {
  return staff(actor) || (actor.role === UserRole.USER && !!actor.departmentId);
}
export function documentScope(doc: Document, actor: Actor): boolean {
  // Destruction review grants the department head access to their department's request,
  // including sensitive records. General document viewing rules are unchanged.
  return requester(actor) && (actor.role === UserRole.ADMIN || (doc.department?.id === actor.departmentId
    && (actor.role !== UserRole.USER || doc.uploader?.id === actor.id)));
}
export function eligibilityReasons(doc: Document, ownRequest?: string): string[] {
  const reasons: string[] = [];
  if (![DocumentStatus.STORED, DocumentStatus.APPROVED].includes(doc.status))
    reasons.push('hồ sơ phải ở trạng thái đã duyệt hoặc đã lưu kho');
  if (doc.classificationValue !== ClassificationValue.TIMED)
    reasons.push(doc.classificationValue === ClassificationValue.PERMANENT
      ? 'hồ sơ được xác định lưu trữ vĩnh viễn' : 'chưa xác định giá trị hồ sơ là có thời hạn');
  if (!doc.documentType) reasons.push('chưa có loại hồ sơ');
  else {
    if (doc.documentType.isPermanent) reasons.push('loại hồ sơ được bảo quản vĩnh viễn');
    if (!['document_date', 'patient_death_date'].includes(doc.documentType.retentionBasis))
      reasons.push('loại hồ sơ chưa có mốc tính thời hạn hợp lệ');
    if (!Number.isSafeInteger(doc.documentType.retentionYears) || doc.documentType.retentionYears <= 0)
      reasons.push('loại hồ sơ chưa có số năm bảo quản hợp lệ');
  }
  if (!doc.retentionUntil || !Number.isFinite(new Date(doc.retentionUntil).getTime()))
    reasons.push('chưa có ngày hết hạn bảo quản hợp lệ; cần bổ sung thông tin để tính thời hạn, không cần chờ đến ngày hết hạn');
  if (doc.legalHold !== false) reasons.push('hồ sơ đang bị khóa bảo toàn hoặc chưa xác định trạng thái khóa');
  if (doc.destructionRequestId && doc.destructionRequestId !== ownRequest)
    reasons.push('hồ sơ đang thuộc một đề nghị hủy khác');
  if (doc.destroyedAt) reasons.push('hồ sơ đã được hủy');
  return reasons;
}
export function eligible(doc: Document, _now: Date, ownRequest?: string): boolean {
  // A signed decision may request destruction before the retention date.
  // Approval, the configured wait and deletion fences are enforced separately.
  return eligibilityReasons(doc, ownRequest).length === 0;
}
export function requiredApprovals(docs: Document[]): number {
  return docs.some(doc => parseDocumentSecurityLevel(doc.securityLevel) !== 'normal') ? 2 : 1;
}
export function approverScope(actor: Actor, docs: Document[]): boolean {
  return actor.role === UserRole.ADMIN || (actor.role === UserRole.DEPARTMENT_HEAD
    && !!actor.departmentId && docs.length > 0 && docs.every(doc => documentScope(doc, actor)));
}
export function canApproveOwnRequest(request: any, actor: Actor, docs: Document[]): boolean {
  return request.requiredApprovals === 1 && actor.role === UserRole.DEPARTMENT_HEAD
    && approverScope(actor, docs) && requiredApprovals(docs) === 1
    && docs.every(doc => doc.uploader?.id === actor.id);
}
export function canApprove(request: any, actor: Actor, approvals: any[], docs: Document[] = [], reviewers: Actor[] = []): boolean {
  return approverScope(actor, docs) && (request.createdBy !== actor.id || canApproveOwnRequest(request, actor, docs))
    && ['pending', 'partially_approved'].includes(request.status)
    && !approvals.some(a => a.userId === actor.id)
    && (request.requiredApprovals !== 2 || (reviewers.length === approvals.length
      && reviewers.every(reviewer => approverScope(reviewer, docs) && reviewer.role !== actor.role)));
}
export function approvalsValid(request: any, docs: Document[], approvals: any[], reviewers: Actor[]): boolean {
  return docs.length > 0 && request.requiredApprovals === requiredApprovals(docs)
    && approvals.length === request.requiredApprovals && reviewers.length === approvals.length
    && new Set(approvals.map(a => a.userId)).size === approvals.length
    && approvals.every(a => a.digest === request.digest
      && reviewers.some(actor => actor.id === a.userId && approverScope(actor, docs)
        && (a.userId !== request.createdBy || canApproveOwnRequest(request, actor, docs))))
    && (request.requiredApprovals !== 2 || (reviewers.some(a => a.role === UserRole.ADMIN)
      && reviewers.some(a => a.role === UserRole.DEPARTMENT_HEAD)));
}
export function actions(request: any, actor: Actor, approvals: any[], now: Date, docs: Document[] = [], reviewers: Actor[] = []): string[] {
  const result: string[] = [];
  if (canApprove(request, actor, approvals, docs, reviewers)) result.push('approve');
  if (approverScope(actor, docs) && request.createdBy !== actor.id
    && ['pending', 'partially_approved'].includes(request.status)) result.push('reject');
  if ((request.createdBy === actor.id || actor.role === UserRole.ADMIN)
    && (['pending', 'partially_approved'].includes(request.status)
      || (request.status === 'scheduled' && !!request.executeAfter && now < new Date(request.executeAfter)))) result.push('withdraw');
  if (actor.role === UserRole.ADMIN && request.status === 'destroyed') result.push('complete');
  return result;
}
export function text(value: unknown, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    fail(422, 'INVALID_INPUT', 'Thông tin không hợp lệ hoặc vượt độ dài cho phép.');
  return value.trim();
}
export function matchVersion(value: string | undefined, version: number): void {
  if (value !== `"${version}"`) fail(412, 'VERSION_CONFLICT', 'Phiên bản đã thay đổi. Vui lòng tải lại chi tiết.');
}
export function pagination(query: any) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1
    || page > 1000000) fail(422, 'INVALID_PAGE', 'Thông tin phân trang không hợp lệ.');
  return { page, pageSize: Math.min(pageSize, 100) };
}
