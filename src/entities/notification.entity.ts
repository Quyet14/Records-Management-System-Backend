import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Document } from './document.entity';

export enum NotificationType {
  DOCUMENT_APPROVED  = 'document_approved',
  DOCUMENT_REJECTED  = 'document_rejected',
  DOCUMENT_PENDING   = 'document_pending',
  ROLE_CHANGED       = 'role_changed',
  VIEW_REQUEST_PENDING = 'view_request_pending',
  VIEW_REQUEST_APPROVED = 'view_request_approved',
  VIEW_REQUEST_REJECTED = 'view_request_rejected',
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Người nhận thông báo */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient: User;

  @Column({ type: 'enum', enum: NotificationType })
  type: NotificationType;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text' })
  message: string;

  @ManyToOne(() => Document, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'document_id' })
  document: Document;

  @Column({ name: 'is_read', default: false })
  isRead: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
