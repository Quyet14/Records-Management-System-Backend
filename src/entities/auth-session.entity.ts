import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from './user.entity';

@Entity('auth_sessions')
@Index(['userId', 'revokedAt'])
export class AuthSession {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ name: 'user_id', type: 'varchar', length: 36 }) userId: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' }) user: User;
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 }) expiresAt: Date;
  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true }) revokedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', precision: 3 }) createdAt: Date;
  @Column({ name: 'last_seen_at', type: 'datetime', precision: 3 }) lastSeenAt: Date;
  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true }) ipAddress: string | null;
  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true }) userAgent: string | null;
}
