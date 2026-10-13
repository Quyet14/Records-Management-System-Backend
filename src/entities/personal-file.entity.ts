import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('personal_files')
export class PersonalFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: User;

  /** Tên file gốc */
  @Column({ name: 'original_filename', length: 500 })
  originalFilename: string;

  /** Đường dẫn lưu trữ vật lý */
  @Column({ name: 'storage_path', length: 1000 })
  storagePath: string;

  /** Dung lượng file (bytes) */
  @Column({ name: 'file_size_bytes', type: 'bigint', nullable: true })
  fileSizeBytes: number;

  /** MIME type */
  @Column({ name: 'mime_type', length: 100, nullable: true })
  mimeType: string;

  /** Mô tả tùy chọn */
  @Column({ type: 'text', nullable: true })
  description: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
