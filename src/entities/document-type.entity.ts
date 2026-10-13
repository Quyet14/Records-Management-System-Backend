import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Document } from './document.entity';

/** Mốc tính thời hạn lưu trữ — theo TT 33/2025/TT-BYT */
export enum RetentionBasis {
  /** Tính từ ngày hình thành / kết thúc công việc (mặc định) */
  DOCUMENT_DATE = 'document_date',
  /** Tính từ ngày người bệnh qua đời (ví dụ: Sổ sức khỏe điện tử) */
  PATIENT_DEATH_DATE = 'patient_death_date',
  /** Vĩnh viễn — không có ngày hết hạn */
  PERMANENT = 'permanent',
}

@Entity('document_types')
export class DocumentType {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Mã gợi ý theo TT 33/2025/TT-BYT, ví dụ HS-001 */
  @Column({ length: 20, unique: true })
  code: string;

  /** Tên loại hồ sơ */
  @Column({ length: 500 })
  name: string;

  /** Mô tả thêm (tùy chọn) */
  @Column({ type: 'text', nullable: true })
  description: string;

  /**
   * Thời hạn lưu trữ theo năm.
   * NULL nếu is_permanent = true.
   */
  @Column({ name: 'retention_years', type: 'int', nullable: true })
  retentionYears: number;

  @Column({ name: 'max_view_duration_days', type: 'int', nullable: true })
  maxViewDurationDays: number | null;

  /**
   * Đánh dấu lưu trữ vĩnh viễn.
   * Khi true thì retentionYears phải là NULL.
   */
  @Column({ name: 'is_permanent', default: false })
  isPermanent: boolean;

  /**
   * Mốc tính thời hạn:
   * - document_date: tính từ ngày hình thành tài liệu (mặc định)
   * - patient_death_date: tính từ ngày người bệnh qua đời
   * - permanent: vĩnh viễn
   */
  @Column({
    name: 'retention_basis',
    type: 'enum',
    enum: RetentionBasis,
    default: RetentionBasis.DOCUMENT_DATE,
  })
  retentionBasis: RetentionBasis;

  /** Nhóm chuyên môn theo TT 33/2025/TT-BYT */
  @Column({ length: 200, nullable: true })
  group: string;

  /** Có trong hệ thống mặc định (seed data) hay do Admin tạo thêm */
  @Column({ name: 'is_builtin', default: false })
  isBuiltin: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => Document, (doc) => doc.documentType)
  documents: Document[];
}
