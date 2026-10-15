import { ArrayUnique, IsArray, IsEnum } from 'class-validator';
import { UserPermission } from '../../entities/user.entity';

export class UpdateUserPermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsEnum(UserPermission, { each: true })
  permissions: UserPermission[];
}
