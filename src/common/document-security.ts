import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Document } from '../entities/document.entity';
import { UserRole } from '../entities/user.entity';

export enum DocumentSecurityLevel {
  NORMAL = 'normal',
  CONFIDENTIAL = 'confidential',
  SECRET = 'secret',
  TOP_SECRET = 'top_secret',
}

export interface DocumentSecurityUser {
  id: string;
  role: UserRole;
  departmentId?: string;
}

// Accept existing Vietnamese labels and common frontend values without a DB migration.
const aliases: Record<DocumentSecurityLevel, string[]> = {
  normal: ['', 'normal', 'none', 'thuong', 'thường'],
  confidential: ['confidential', 'mat', 'mật'],
  secret: ['secret', 'highly_confidential', 'toi_mat', 'toi mat', 'tối mật', 'tối_mật'],
  top_secret: ['top_secret', 'top secret', 'tuyet_mat', 'tuyet mat', 'tuyệt mật', 'tuyệt_mật'],
};

export function parseDocumentSecurityLevel(value: unknown): DocumentSecurityLevel | undefined {
  if (value == null) return DocumentSecurityLevel.NORMAL;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  return (Object.keys(aliases) as DocumentSecurityLevel[]).find(level => aliases[level].includes(text));
}

export function normalizeDocumentSecurityLevel(value: unknown): DocumentSecurityLevel {
  const level = parseDocumentSecurityLevel(value);
  if (!level) throw new BadRequestException('Độ mật không hợp lệ. Chọn Thường, Mật, Tối mật hoặc Tuyệt mật.');
  return level;
}

// This is an additional restriction. Existing visibility, review and download rules still apply.
export function canAccessDocumentSecurity(doc: Document, user: DocumentSecurityUser): boolean {
  if (user.role === UserRole.ADMIN || (!!user.id && doc.uploader?.id === user.id)) return true;
  const level = parseDocumentSecurityLevel(doc.securityLevel);
  if (level === DocumentSecurityLevel.NORMAL) return true;
  return level === DocumentSecurityLevel.CONFIDENTIAL
    && user.role === UserRole.DEPARTMENT_HEAD
    && !!user.departmentId && doc.department?.id === user.departmentId;
}

export function assertDocumentSecurityAccess(doc: Document, user: DocumentSecurityUser): void {
  if (!canAccessDocumentSecurity(doc, user)) {
    throw new ForbiddenException('Bạn không có quyền truy cập tài liệu ở độ mật này');
  }
}

export function assertSecurityLevelChange(doc: Document, next: DocumentSecurityLevel, user: DocumentSecurityUser): void {
  const current = parseDocumentSecurityLevel(doc.securityLevel);
  const ranks = Object.values(DocumentSecurityLevel);
  if (user.role !== UserRole.ADMIN && (current == null || ranks.indexOf(next) < ranks.indexOf(current))) {
    throw new ForbiddenException('Chỉ Admin được hạ độ mật của tài liệu');
  }
}

// Filter in SQL BEFORE pagination/counting so hidden documents cannot affect results.
export function applyDocumentSecurityScope<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>, user: DocumentSecurityUser, alias = 'doc', includeMissing = false,
): SelectQueryBuilder<T> {
  if (user.role === UserRole.ADMIN) return qb;
  const level = `CAST(LOWER(TRIM(COALESCE(${alias}.securityLevel, ''))) AS BINARY)`;
  const parts = [
    `${level} IN (:...securityNormalLevels)`,
    `${alias}.uploader_id = :securityUserId`,
  ];
  const parameters: Record<string, unknown> = { securityNormalLevels: aliases.normal, securityUserId: user.id };
  if (user.role === UserRole.DEPARTMENT_HEAD && user.departmentId) {
    parts.push(`(${level} IN (:...securityConfidentialLevels) AND ${alias}.department_id = :securityDepartmentId)`);
    parameters.securityConfidentialLevels = aliases.confidential;
    parameters.securityDepartmentId = user.departmentId;
  }
  if (includeMissing) parts.push(`${alias}.id IS NULL`);
  return qb.andWhere(`(${parts.join(' OR ')})`, parameters);
}
