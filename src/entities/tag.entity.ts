import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Document } from './document.entity';

@Entity('tags')
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Tên tag — unique, lowercase để tránh trùng */
  @Column({ unique: true, length: 100 })
  name: string;

  @ManyToMany(() => Document, (doc) => doc.tags)
  documents: Document[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
