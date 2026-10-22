import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { UserRole } from '../../entities/user.entity';

@Injectable()
export class RecentAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const user = context.switchToHttp().getRequest().user;
    const age = Date.now() / 1000 - Number(user?.authTime);
    if (!user?.sessionId || ['file-download', 'file-view'].includes(user?.tokenType)
      || !Number.isFinite(age) || age < -30 || age > 300)
      throw new ForbiddenException({ code: 'RECENT_AUTH_REQUIRED', message: 'Cần xác thực lại bằng OTP trong 5 phút gần nhất để thực hiện thao tác này.' });
    return true;
  }
}

@Injectable()
export class ProfileSecurityAuthGuard extends RecentAuthGuard {
  canActivate(context: ExecutionContext) {
    const body = context.switchToHttp().getRequest().body || {};
    return body.email !== undefined || body.departmentId !== undefined ? super.canActivate(context) : true;
  }
}

@Injectable()
export class PermissionUpdateAuthGuard extends RecentAuthGuard {
  canActivate(context: ExecutionContext) {
    const user = context.switchToHttp().getRequest().user;
    if (user?.role === UserRole.DEPARTMENT_HEAD) return true;
    return super.canActivate(context);
  }
}
