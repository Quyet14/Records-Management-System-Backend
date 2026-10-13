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

  @ManyToOne(() => Department, { nullable: true })
  @JoinColumn({ name: 'department_id' })
  department: Department;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

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
