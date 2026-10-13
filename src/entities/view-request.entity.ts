import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Document } from './document.entity';
import { User } from './user.entity';

export enum ViewRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

@Entity('view_requests')
export class ViewRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: Document;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requester_id' })
  requester: User;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'approver_id' })
  approver: User;

  @Column({ type: 'text' })
  reason: string;

  @Column({
    type: 'enum',
    enum: ViewRequestStatus,
    default: ViewRequestStatus.PENDING,
  })
  status: ViewRequestStatus;

  @Column({ name: 'decision_note', type: 'text', nullable: true })
  decisionNote: string;

  @Column({ name: 'access_expires_at', type: 'timestamp', nullable: true })
  accessExpiresAt: Date;

  @Column({ name: 'requested_duration', type: 'int', nullable: true })
  requestedDuration: number | null;

  @Column({ name: 'approved_duration', type: 'int', nullable: true })
  approvedDuration: number | null;

  @ManyToOne(() => ViewRequest, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'extended_from_request_id' })
  extendedFromRequest: ViewRequest | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'decided_at', type: 'timestamp', nullable: true })
  decidedAt: Date;
}
