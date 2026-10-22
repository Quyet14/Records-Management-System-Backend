import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  ManyToMany,
  ManyToOne,
  JoinColumn,
  JoinTable,
  CreateDateColumn,
} from 'typeorm';
import { Department } from './department.entity';
import { User } from './user.entity';
import { Tag } from './tag.entity';
import { DocumentType } from './document-type.entity';
import { StoredFile } from './stored-file.entity';

export enum DocumentStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  STORED = 'stored',
  DESTROYED = 'destroyed',
}

/** Phạm vi hiển thị tài liệu */
export enum DocumentVisibility {
  PUBLIC     = 'public',      // Tất cả user trong hệ thống thấy
  DEPARTMENT = 'department',  // Chỉ người cùng khoa thấy (mặc định)
  PRIVATE    = 'private',     // Chỉ người upload + admin thấy
}

export enum ExtractedTextStatus {
  NONE = 'none',
  NATIVE = 'native',
  OCR = 'ocr',
  FAILED = 'failed',
}

/** Mức giá trị tài liệu theo Luật Lưu trữ 33/2024/QH15 */
export enum ClassificationValue {
  PERMANENT = 'permanent',   // Vĩnh viễn
  TIMED = 'timed',           // Có thời hạn
  UNCLASSIFIED = 'unclassified', // Chưa xác định
}

/** Trạng thái chỉnh lý / xác định giá trị */
export enum ReviewStatus {
  PENDING = 'pending',         // Chưa chỉnh lý
  IN_PROGRESS = 'in_progress', // Đang chỉnh lý
  COMPLETED = 'completed',     // Đã hoàn thành
}

@Entity('documents')
export class Document {
  @Column({ name: 'retention_until', type: 'datetime', precision: 3, nullable: true })
  retentionUntil: Date | null;

  @Column({ name: 'legal_hold', default: false })
  legalHold: boolean;

  @Column({ name: 'destroyed_at', type: 'datetime', precision: 3, nullable: true })
  destroyedAt: Date | null;

  @Column({ name: 'destruction_started_at', type: 'datetime', precision: 3, nullable: true })
  destructionStartedAt: Date | null;

  @Column({ name: 'destruction_request_id', type: 'varchar', length: 36, nullable: true })
  destructionRequestId: string | null;

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'original_filename', length: 500 })
  originalFilename: string;

  @Column({ length: 500, nullable: true })
  title: string;

  /** Trích yếu / tóm tắt nội dung văn bản */
  @Column({ name: 'summary', type: 'text', nullable: true })
  summary: string;

  /** Số ký hiệu văn bản */
  @Column({ name: 'reference_no', length: 100, nullable: true })
  referenceNo: string;

  /** Đơn vị ban hành */
  @Column({ name: 'issuing_unit', length: 255, nullable: true })
  issuingUnit: string;

  /** Ban tổ chức trưng cầu / cơ quan chủ trì */
  @Column({ name: 'organizing_body', length: 255, nullable: true })
  organizingBody: string;

  /** Ngày đến */
  @Column({ name: 'received_date', type: 'date', nullable: true })
  receivedDate: Date;

  /** Số văn bản */
  @Column({ name: 'document_number', length: 100, nullable: true })
  documentNumber: string;

  /** Độ mật / mức độ bảo mật */
  @Column({ name: 'security_level', length: 50, nullable: true })
  securityLevel: string;

  /** Người soạn thảo / người ký */
  @Column({ name: 'author_name', length: 255, nullable: true })
  authorName: string;

  @Column({ type: 'mediumtext', nullable: true })
  description: string;

  @ManyToOne(() => Department, { nullable: true })
  @JoinColumn({ name: 'department_id' })
  department: Department;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'uploader_id' })
  uploader: User;

  @ManyToOne(() => StoredFile, { nullable: true })
  @JoinColumn({ name: 'file_id' })
  file: StoredFile;

  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.PENDING,
  })
  status: DocumentStatus;

  @Column({ name: 'reject_reason', type: 'text', nullable: true })
  rejectReason: string;

  @Column({ name: 'storage_path', length: 1000 })
  storagePath: string;

  @Column({ name: 'sha256_checksum', length: 64, nullable: true })
  sha256Checksum: string;

  @Column({ name: 'file_size_bytes', type: 'bigint', nullable: true })
  fileSizeBytes: number;

  @Column({
    name: 'extracted_text_status',
    type: 'enum',
    enum: ExtractedTextStatus,
    default: ExtractedTextStatus.NONE,
  })
  extractedTextStatus: ExtractedTextStatus;

  @Column({ default: 1 })
  version: number;

  /**
   * Phạm vi hiển thị:
   * - public: tất cả user thấy
   * - department: chỉ cùng khoa (mặc định)
   * - private: chỉ uploader + admin
   */
  @Column({
    type: 'enum',
    enum: DocumentVisibility,
    default: DocumentVisibility.DEPARTMENT,
  })
  visibility: DocumentVisibility;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'approved_at', type: 'timestamp', nullable: true })
  approvedAt: Date;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'approved_by' })
  approvedBy: User;

  @ManyToMany(() => Tag, (tag) => tag.documents, { eager: false })
  @JoinTable({
    name: 'document_tags',
    joinColumn: { name: 'document_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags: Tag[];

  // ─── Trường bổ sung theo Luật Lưu trữ 33/2024 + TT 33/2025/TT-BYT ───

  /**
   * Ngày hình thành tài liệu (có thể khác ngày upload).
   * Dùng để tính hạn lưu trữ theo RetentionBasis.DOCUMENT_DATE.
   */
  @Column({ name: 'document_date', type: 'date', nullable: true })
  documentDate: Date;

  /**
   * Loại hồ sơ — liên kết bảng document_types.
   * Admin gán khi duyệt hoặc user chọn khi upload.
   */
  @ManyToOne(() => DocumentType, { nullable: true, eager: false })
  @JoinColumn({ name: 'document_type_id' })
  documentType: DocumentType;

  /**
   * Mức giá trị tài liệu theo Luật 33/2024/QH15:
   * vĩnh viễn / có thời hạn / chưa xác định.
   */
  @Column({
    name: 'classification_value',
    type: 'enum',
    enum: ClassificationValue,
    default: ClassificationValue.UNCLASSIFIED,
  })
  classificationValue: ClassificationValue;

  /**
   * Trạng thái chỉnh lý / xác định giá trị.
   * Áp dụng cho tài liệu hình thành trước 01/7/2025
   * (hạn chót chỉnh lý xong: 01/7/2030 theo Luật 01/2011).
   */
  @Column({
    name: 'review_status',
    type: 'enum',
    enum: ReviewStatus,
    default: ReviewStatus.PENDING,
  })
  reviewStatus: ReviewStatus;

  /**
   * Ngày tính hết hạn lưu trữ.
   * Được tính tự động khi Admin duyệt nếu documentType đã được gán.
   * NULL = chưa tính hoặc vĩnh viễn.
   */
  @Column({ name: 'expires_at', type: 'date', nullable: true })
  expiresAt: Date;

  /**
   * Ngày người bệnh qua đời — dùng để tính hạn lưu trữ
   * cho loại hồ sơ có retention_basis = patient_death_date
   * (ví dụ: Sổ sức khỏe điện tử).
   */
  @Column({ name: 'patient_death_date', type: 'date', nullable: true })
  patientDeathDate: Date;
}
