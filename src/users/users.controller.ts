import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserPermissionsDto } from './dto/update-user-permissions.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../entities/user.entity';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private service: UsersService) {}

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateUserDto) {
    return this.service.create(dto);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  findAll(@CurrentUser() user) {
    if (user.role === UserRole.ADMIN) {
      return this.service.findAll();
    }
    return this.service.findByDepartment(user.departmentId);
  }

  @Get('me')
  getCurrentUser(@CurrentUser() user) {
    return this.service.findById(user.id);
  }

  @Get('assignable-permissions')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  getAssignablePermissions() {
    return this.service.getAssignablePermissions();
  }

  @Patch(':id/role')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() admin,
  ) {
    return this.service.updateRole(id, dto, admin);
  }

  @Patch(':id/permissions')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  updatePermissions(
    @Param('id') id: string,
    @Body() dto: UpdateUserPermissionsDto,
    @CurrentUser() actor,
  ) {
    return this.service.updatePermissions(id, dto.permissions, actor);
  }

  /** PATCH /users/:id — Admin sửa thông tin đầy đủ, user thường sửa profile của mình */
  @Patch(':id')
  updateProfile(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor,
  ) {
    // User thường chỉ được sửa profile của chính mình
    if (actor.role !== UserRole.ADMIN && actor.id !== id) {
      throw new ForbiddenException('Bạn chỉ được chỉnh sửa thông tin của chính mình');
    }
    return this.service.update(id, dto, actor);
  }

  @Patch(':id/active')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  setActive(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
    @CurrentUser() actor,
  ) {
    return this.service.setActive(id, isActive, actor);
  }
}
