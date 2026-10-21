import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Hash của refresh token (không lưu raw token) */
  @Column({ name: 'token_hash', length: 64, unique: true })
  tokenHash: string;

  @Index()
  @Column({ name: 'session_id', type: 'varchar', length: 36, nullable: true })
  sessionId: string | null;

  @Column({ name: 'consumed_at', type: 'datetime', precision: 3, nullable: true })
  consumedAt: Date | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** IP tạo token — để audit */
  @Column({ name: 'ip_address', length: 45, nullable: true, type: 'varchar' })
  ipAddress: string;

  @Column({ name: 'expires_at' })
  expiresAt: Date;

  /** Revoke thủ công (logout) hoặc do admin thu hồi */
  @Column({ name: 'is_revoked', default: false })
  isRevoked: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
