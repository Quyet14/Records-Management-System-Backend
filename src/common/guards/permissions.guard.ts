import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { UserPermission, UserRole } from '../../entities/user.entity';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<UserPermission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredPermissions || requiredPermissions.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (user?.role === UserRole.ADMIN || user?.role === UserRole.DEPARTMENT_HEAD) {
      return true;
    }

    const permissions = new Set<UserPermission>(user?.permissions ?? []);
    return requiredPermissions.every((permission) => permissions.has(permission));
  }
}
