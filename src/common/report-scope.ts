import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../entities/user.entity';

export interface ReportActor { role: UserRole; departmentId?: string }

/** Only use the identity refreshed from DB by JwtStrategy, never a client department filter. */
export function reportDepartment(actor: ReportActor): string | undefined {
  if (actor?.role === UserRole.ADMIN) return undefined;
  if (actor?.role !== UserRole.DEPARTMENT_HEAD) throw new ForbiddenException('Bạn không có quyền xem báo cáo.');
  if (!actor.departmentId?.trim()) throw new ForbiddenException('Tài khoản chưa được gán khoa.');
  return actor.departmentId;
}
