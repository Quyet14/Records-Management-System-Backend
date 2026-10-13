import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Document } from './document.entity';

@Entity('document_versions')
export class DocumentVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Document)
  @JoinColumn({ name: 'document_id' })
  document: Document;

  @Column({ name: 'storage_path', length: 1000 })
  storagePath: string;

  @Column({ name: 'sha256_checksum', length: 64, nullable: true })
  sha256Checksum: string;

  @Column()
  version: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
