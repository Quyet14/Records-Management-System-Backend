import { SetMetadata } from '@nestjs/common';
import { UserPermission } from '../../entities/user.entity';

export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...permissions: UserPermission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
