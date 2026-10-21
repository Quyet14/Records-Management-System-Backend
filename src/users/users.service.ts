import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcrypt';
import {
  DEFAULT_USER_PERMISSIONS,
  User,
  UserPermission,
  UserRole,
} from '../entities/user.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';

export interface AuthUser {
  id: string;
  role: UserRole;
  departmentId?: string;
}

export const ASSIGNABLE_USER_PERMISSIONS = [
  UserPermission.APPROVE_DOCUMENTS,
  UserPermission.VIEW_DEPARTMENT_DOCUMENTS,
  UserPermission.ADD_DOCUMENT_COMMENTS,
] as const;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private repo: Repository<User>,
    @InjectRepository(AuditLog) private auditRepo: Repository<AuditLog>,
    @InjectRepository(RefreshToken) private rtRepo: Repository<RefreshToken>,
    private eventEmitter: EventEmitter2,
  ) {}

  /** Thu hồi toàn bộ refresh token của user — buộc đăng nhập lại */
  private async revokeAllTokens(userId: string): Promise<void> {
    await this.rtRepo.manager.update(AuthSession, { userId }, { revokedAt: new Date() });
    await this.rtRepo.update(
      { user: { id: userId }, isRevoked: false },
      { isRevoked: true },
    );
  }

  async create(dto: CreateUserDto): Promise<User> {
    const existing = await this.repo.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email đã được sử dụng');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.repo.create({
      fullName: dto.fullName,
      email: dto.email,
      passwordHash,
      mustChangePassword: true,
      role: dto.role || UserRole.USER,
      permissions:
        (dto.role || UserRole.USER) === UserRole.USER
          ? [...DEFAULT_USER_PERMISSIONS]
          : [],
      department: dto.departmentId ? ({ id: dto.departmentId } as any) : null,
    });
    return this.repo.save(user);
  }

  async findAll() {
    const users = await this.repo.find({ relations: ['department'] });
    return users.map((user) => this.withEffectivePermissions(user));
  }

  async findByDepartment(departmentId: string): Promise<User[]> {
    const users = await this.repo
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.department', 'department')
      .where('department.id = :departmentId', { departmentId })
      .andWhere('user.role != :adminRole', { adminRole: UserRole.ADMIN })
      .getMany();
    return users.map((user) => this.withEffectivePermissions(user));
  }

  getAssignablePermissions() {
    return [
      { key: UserPermission.VIEW_DEPARTMENT_DOCUMENTS, label: 'Xem tài liệu nội bộ khoa', description: 'Xem trực tiếp tài liệu nội bộ cùng khoa đã duyệt, không cần gửi yêu cầu.' },
      { key: UserPermission.ADD_DOCUMENT_COMMENTS, label: 'Thêm ghi chú tài liệu', description: 'Thêm ghi chú vào tài liệu được phép tra cứu.' },
      { key: UserPermission.APPROVE_DOCUMENTS, label: 'Phê duyệt tài liệu tải lên', description: 'Xem hàng chờ, phê duyệt hoặc từ chối tài liệu trong cùng khoa.' },
    ];
  }

  async update(
    id: string,
    dto: {
      fullName?: string;
      email?: string;
      position?: string;
      qualification?: string;
      cccd?: string;
      phone?: string;
      dateOfBirth?: string;
      gender?: string;
      departmentId?: string;
    },
    actor: { role: UserRole },
  ): Promise<User> {
    const user = await this.findById(id);

    if (dto.fullName !== undefined)      user.fullName      = dto.fullName;
    if (dto.position !== undefined)      user.position      = dto.position;
    if (dto.qualification !== undefined) user.qualification = dto.qualification;
    if (dto.cccd !== undefined)          user.cccd          = dto.cccd;
    if (dto.phone !== undefined)         user.phone         = dto.phone;
    if (dto.gender !== undefined)        user.gender        = dto.gender;
    if (dto.dateOfBirth !== undefined) {
      user.dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null as any;
    }

    // Chỉ Admin được sửa email và chuyển khoa
    if (actor.role === UserRole.ADMIN) {
      if (dto.email !== undefined) {
        const existing = await this.repo.findOne({ where: { email: dto.email } });
        if (existing && existing.id !== id) {
          throw new ConflictException('Email này đã được sử dụng bởi tài khoản khác');
        }
        user.email = dto.email;
      }
      if (dto.departmentId !== undefined) {
        user.department = dto.departmentId ? ({ id: dto.departmentId } as any) : null;
      }
    }

    return this.repo.save(user);
  }

  async findById(id: string): Promise<User> {
    const user = await this.repo.findOne({
      where: { id },
      relations: ['department'],
    });
    if (!user) throw new NotFoundException('Không tìm thấy người dùng');
    return this.withEffectivePermissions(user);
  }

  async updateRole(
    targetId: string,
    dto: UpdateUserRoleDto,
    actor: AuthUser,
  ): Promise<User> {
    const target = await this.findById(targetId);

    if (actor.role === UserRole.DEPARTMENT_HEAD) {
      if (target.role === UserRole.DEPARTMENT_HEAD) {
        throw new ForbiddenException(
          'Truong khoa khong duoc phan quyen cho tai khoan Truong khoa khac',
        );
      }
      if (!actor.departmentId) {
        throw new ForbiddenException('Tai khoan Truong khoa chua duoc gan khoa');
      }
      if (target.role !== UserRole.USER) {
        throw new ForbiddenException(
          'Truong khoa chi duoc phan quyen cho nhan vien thuong',
        );
      }
      if (!target.department || target.department.id !== actor.departmentId) {
        throw new ForbiddenException(
          'Ban chi co the phan quyen cho nhan vien trong khoa minh',
        );
      }
      if (dto.role !== UserRole.USER) {
        throw new ForbiddenException(
          'Truong khoa khong duoc cap quyen Truong khoa hoac Admin',
        );
      }
      if (dto.departmentId && dto.departmentId !== actor.departmentId) {
        throw new ForbiddenException(
          'Truong khoa khong duoc chuyen nhan vien sang khoa khac',
        );
      }
    }

    if (dto.role === UserRole.DEPARTMENT_HEAD && !dto.departmentId) {
      throw new BadRequestException('Trưởng khoa phải thuộc một khoa');
    }

    const oldRole = target.role;
    target.role = dto.role;
    target.permissions =
      dto.role === UserRole.USER
        ? target.permissions ?? [...DEFAULT_USER_PERMISSIONS]
        : [];
    if (actor.role === UserRole.ADMIN && dto.departmentId) {
      target.department = { id: dto.departmentId } as any;
    }

    const saved = await this.repo.save(target);

    // Revoke toàn bộ token cũ — user phải đăng nhập lại để nhận role mới trong JWT
    await this.revokeAllTokens(targetId);

    try {
      const entry = this.auditRepo.create({
        actor: { id: actor.id } as any,
        action: 'role_change',
        metadata: {
          targetUserId: targetId,
          oldRole,
          newRole: dto.role,
          departmentId: dto.departmentId ?? null,
        },
      });
      await this.auditRepo.save(entry);
    } catch (_) {
      // Audit failures must not block the main operation
    }

    // Emit event để gửi thông báo cho người bị đổi role
    this.eventEmitter.emit('role.changed', {
      targetUserId: targetId,
      targetEmail: target.email,
      targetName: target.fullName,
      oldRole,
      newRole: dto.role,
    });

    return this.findById(saved.id);
  }

  async updatePermissions(
    targetId: string,
    permissions: UserPermission[],
    actor: AuthUser,
  ): Promise<User> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.DEPARTMENT_HEAD) {
      throw new ForbiddenException('Bạn không có quyền phân quyền nhân viên');
    }
    const target = await this.findById(targetId);
    const nextPermissions = this.normalizeAssignablePermissions(permissions);

    if (target.role !== UserRole.USER) {
      throw new ForbiddenException(
        'Chi co the phan quyen chi tiet cho tai khoan nhan vien thuong',
      );
    }

    if (actor.role === UserRole.DEPARTMENT_HEAD) {
      if (!actor.departmentId) {
        throw new ForbiddenException('Tai khoan Truong khoa chua duoc gan khoa');
      }
      if (!target.department || target.department.id !== actor.departmentId) {
        throw new ForbiddenException(
          'Ban chi co the phan quyen cho nhan vien trong khoa minh',
        );
      }
    }

    target.permissions = nextPermissions;
    const saved = await this.repo.save(target);
    await this.revokeAllTokens(targetId);

    try {
      const entry = this.auditRepo.create({
        actor: { id: actor.id } as any,
        action: 'permission_change',
        metadata: {
          targetUserId: targetId,
          permissions: nextPermissions,
        },
      });
      await this.auditRepo.save(entry);
    } catch (_) {
      // Audit failures must not block the main operation
    }

    return this.findById(saved.id);
  }

  async setActive(
    id: string,
    isActive: boolean,
    actor: AuthUser,
  ): Promise<User> {
    const target = await this.findById(id);

    if (actor.role === UserRole.DEPARTMENT_HEAD) {
      if (target.role !== UserRole.USER) {
        throw new ForbiddenException(
          'Truong khoa chi duoc thay doi trang thai tai khoan nhan vien thuong',
        );
      }
      if (!target.department || target.department.id !== actor.departmentId) {
        throw new ForbiddenException(
          'Bạn chỉ có thể quản lý tài khoản trong khoa mình',
        );
      }
    }

    await this.repo.update(id, { isActive });

    // Nếu vô hiệu hoá → revoke toàn bộ token, user bị đăng xuất ngay lập tức
    if (!isActive) {
      await this.revokeAllTokens(id);
    }

    try {
      const entry = this.auditRepo.create({
        actor: { id: actor.id } as any,
        action: 'set_active',
        metadata: { targetUserId: id, isActive },
      });
      await this.auditRepo.save(entry);
    } catch (_) {
      // Audit failures must not block the main operation
    }

    return this.findById(id);
  }

  private normalizeAssignablePermissions(
    permissions: UserPermission[] | undefined,
  ): UserPermission[] {
    const allowed = new Set<UserPermission>(ASSIGNABLE_USER_PERMISSIONS);
    return Array.from(new Set((permissions ?? []).map(permission =>
      permission === UserPermission.REQUEST_DOCUMENT_VIEW ? UserPermission.VIEW_DEPARTMENT_DOCUMENTS : permission,
    ))).filter((permission) =>
      allowed.has(permission),
    );
  }

  private withEffectivePermissions(user: User): User {
    if (user.permissions != null) {
      user.permissions = this.normalizeAssignablePermissions(user.permissions);
    }
    if (user.role === UserRole.USER && user.permissions == null) {
      user.permissions = [...DEFAULT_USER_PERMISSIONS];
    }
    if (user.role !== UserRole.USER && user.permissions == null) {
      user.permissions = [];
    }
    return user;
  }
}
