import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('files')
export class StoredFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'file_hash', length: 64, unique: true })
  fileHash: string;

  @Column({ name: 'storage_key', length: 1000 })
  storageKey: string;

  @Column({ type: 'bigint' })
  size: number;

  @Column({ name: 'mime_type', length: 255, default: 'application/octet-stream' })
  mimeType: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
