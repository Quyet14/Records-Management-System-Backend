import { Document, DocumentStatus, DocumentVisibility } from '../entities/document.entity';
import { UserPermission, UserRole } from '../entities/user.entity';
import { canAccessDocumentSecurity } from './document-security';

export function canReviewDepartmentDocuments(
  user: { role: UserRole; departmentId?: string; permissions?: UserPermission[] },
): boolean {
  return !!user.departmentId && (
    user.role === UserRole.DEPARTMENT_HEAD ||
    (user.role === UserRole.USER && (user.permissions ?? []).includes(UserPermission.APPROVE_DOCUMENTS))
  );
}

export function canReviewDocument(
  doc: Document,
  user: { id: string; role: UserRole; departmentId?: string; permissions?: UserPermission[] },
): boolean {
  return canAccessDocumentSecurity(doc, user) && (user.role === UserRole.ADMIN || (
    canReviewDepartmentDocuments(user) && doc.department?.id === user.departmentId
  ));
}

export function canViewDepartmentDocument(
  doc: Document,
  user: { id: string; role: UserRole; departmentId?: string; permissions?: UserPermission[] },
): boolean {
  return canAccessDocumentSecurity(doc, user) && user.role === UserRole.USER
    && !!user.departmentId
    && doc.department?.id === user.departmentId
    && [DocumentVisibility.DEPARTMENT, DocumentVisibility.PUBLIC].includes(doc.visibility)
    && [DocumentStatus.STORED, DocumentStatus.APPROVED].includes(doc.status)
    && (user.permissions ?? []).some(permission =>
      permission === UserPermission.VIEW_DEPARTMENT_DOCUMENTS || permission === UserPermission.REQUEST_DOCUMENT_VIEW);
}
