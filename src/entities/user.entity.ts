import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Department } from './department.entity';

export enum UserRole {
  USER = 'user',
  DEPARTMENT_HEAD = 'department_head',
  ADMIN = 'admin',
}

export enum UserPermission {
  APPROVE_SENSITIVE_DESTRUCTION = 'approve_sensitive_destruction',
  APPROVE_DOCUMENTS = 'approve_documents',
  REQUEST_DOCUMENT_VIEW = 'request_document_view',
  VIEW_DEPARTMENT_DOCUMENTS = 'view_department_documents',
  ADD_DOCUMENT_COMMENTS = 'add_document_comments',
}

export const DEFAULT_USER_PERMISSIONS: UserPermission[] = [];

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'full_name', length: 255 })
  fullName: string;

  @Column({ unique: true, length: 255 })
  email: string;

  @Column({ name: 'password_hash', length: 255, select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Column({ type: 'simple-json', nullable: true })
  permissions: UserPermission[] | null;

  @ManyToOne(() => Department, { nullable: true })
  @JoinColumn({ name: 'department_id' })
  department: Department;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'failed_auth_attempts', type: 'int', default: 0 }) failedAuthAttempts: number;
  @Column({ name: 'auth_locked_until', type: 'datetime', precision: 3, nullable: true }) authLockedUntil: Date | null;

  @Column({ name: 'must_change_password', default: false })
  mustChangePassword: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // ─── Thông tin bổ sung từ danh sách nhân viên ─────────────

  /** Chức danh/chức vụ: Trưởng khoa, Bác sĩ, Điều dưỡng... */
  @Column({ length: 200, nullable: true })
  position: string;

  /** Trình độ: Tiến sĩ Bác sĩ, Thạc sĩ, BSCK I... */
  @Column({ length: 200, nullable: true })
  qualification: string;

  /** Số CCCD/CMND */
  @Column({ length: 20, nullable: true })
  cccd: string;

  /** Số điện thoại */
  @Column({ length: 20, nullable: true })
  phone: string;

  /** Ngày sinh */
  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: Date;

  /** Giới tính: male / female */
  @Column({ length: 10, nullable: true })
  gender: string;
}
