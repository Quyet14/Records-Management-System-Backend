import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('auth_captchas')
export class AuthCaptcha {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ name: 'code_hash', length: 64 }) codeHash: string;
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 }) expiresAt: Date;
  @Column({ default: 0 }) attempts: number;
  @Column({ name: 'used_at', type: 'datetime', precision: 3, nullable: true }) usedAt: Date | null;
}
