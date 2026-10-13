import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import { Document } from './document.entity';
import { User } from './user.entity';

export enum AccessLogAction {
  REQUESTED = 'requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  VIEWED = 'viewed',
}

@Entity('access_logs')
export class AccessLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: Document;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: AccessLogAction })
  action: AccessLogAction;

  @CreateDateColumn({ name: 'timestamp' })
  timestamp: Date;
}
