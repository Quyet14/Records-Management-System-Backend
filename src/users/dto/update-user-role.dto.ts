import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { UserRole } from '../../entities/user.entity';

export class UpdateUserRoleDto {
  @IsEnum(UserRole)
  role: UserRole;

  @IsUUID()
  @IsOptional()
  departmentId?: string;
}
