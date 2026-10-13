import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('otp_codes')
export class OtpCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  /** Mã OTP 6 số đã hash (bcrypt) */
  @Column({ name: 'code_hash', length: 64 })
  codeHash!: string;

  /** Hết hạn sau 5 phút */
  @Column({ name: 'expires_at' })
  expiresAt!: Date;

  /** Đã dùng rồi — không dùng lại được */
  @Column({ name: 'is_used', default: false })
  isUsed!: boolean;

  @Column({ type: 'varchar', length: 30, default: 'login' })
  purpose!: string;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** IP gửi request login */
  @Column({ name: 'ip_address', length: 45, nullable: true })
  ipAddress!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
