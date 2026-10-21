import { Column, Entity, PrimaryColumn, Index } from 'typeorm';

@Entity('destruction_requests')
@Index(['status', 'createdAt'])
export class DestructionRequest {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ unique: true, length: 64 }) code: string;
  @Column({ type: 'text' }) reason: string;
  @Column({ name: 'decision_number', length: 100 }) decisionNumber: string;
  @Column({ name: 'decision_date', type: 'date' }) decisionDate: string;
  @Column({ length: 32 }) status: string;
  @Column({ name: 'created_by', length: 36 }) createdBy: string;
  @Column({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt: Date;
  @Column({ name: 'required_approvals' }) requiredApprovals: number;
  @Column({ name: 'execute_after', type: 'datetime', precision: 3, nullable: true }) executeAfter: Date | null;
  @Column({ name: 'destroyed_at', type: 'datetime', precision: 3, nullable: true }) destroyedAt: Date | null;
  @Column({ name: 'completed_at', type: 'datetime', precision: 3, nullable: true }) completedAt: Date | null;
  @Column({ name: 'completed_by', type: 'varchar', length: 36, nullable: true }) completedBy: string | null;
  @Column() version: number;
  @Column({ length: 64 }) digest: string;
  @Column({ name: 'backup_policy_snapshot', type: 'json' }) backupPolicy: any;
  @Column({ name: 'backup_disposition_notes', type: 'text', nullable: true }) backupDispositionNotes: string | null;
  @Column({ name: 'failure_reason', type: 'text', nullable: true }) failureReason: string | null;
}
@Entity('destruction_items')
@Index(['requestId', 'documentId'], { unique: true })
export class DestructionItem {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ name: 'request_id', length: 36 }) requestId: string;
  @Column({ name: 'document_id', length: 36 }) documentId: string;
  @Column({ type: 'json' }) snapshot: any;
  @Column({ length: 32 }) status: string;
  @Column({ name: 'checksum_at_destruction', type: 'varchar', length: 64, nullable: true }) checksumAtDestruction: string | null;
  @Column({ name: 'destroyed_at', type: 'datetime', precision: 3, nullable: true }) destroyedAt: Date | null;
  @Column({ name: 'execution_result', type: 'json', nullable: true }) executionResult: any;
}
@Entity('destruction_attachments')
@Index(['requestId'])
export class DestructionAttachment {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ name: 'request_id', length: 36 }) requestId: string;
  @Column({ length: 32 }) type: string;
  @Column({ length: 255 }) filename: string;
  @Column({ name: 'object_key', unique: true, length: 255 }) objectKey: string;
  @Column() size: number;
  @Column({ length: 64 }) sha256: string;
  @Column({ name: 'uploaded_by', length: 36 }) uploadedBy: string;
  @Column({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt: Date;
  @Column({ name: 'signature_validation_result', type: 'json' }) signatureValidationResult: any;
}
@Entity('destruction_attachment_content')
export class DestructionAttachmentContent {
  @PrimaryColumn({ name: 'attachment_id', type: 'varchar', length: 36 }) attachmentId: string;
  @Column({ type: 'longblob', select: false }) bytes: Buffer;
}
@Entity('destruction_approvals')
@Index(['requestId', 'userId'], { unique: true })
export class DestructionApproval {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ name: 'request_id', length: 36 }) requestId: string;
  @Column({ name: 'user_id', length: 36 }) userId: string;
  @Column({ name: 'approved_at', type: 'datetime', precision: 3 }) approvedAt: Date;
  @Column() version: number;
  @Column({ length: 64 }) digest: string;
  @Column({ name: 'otp_challenge_id', length: 36, unique: true }) otpChallengeId: string;
}
@Entity('destruction_otp_challenges')
@Index(['actorId', 'createdAt'])
export class DestructionOtpChallenge {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ name: 'request_id', length: 36 }) requestId: string;
  @Column({ name: 'actor_id', length: 36 }) actorId: string;
  @Column({ length: 32 }) purpose: string;
  @Column({ name: 'bound_version' }) boundVersion: number;
  @Column({ name: 'bound_digest', length: 64 }) boundDigest: string;
  @Column({ name: 'verifier_hash', length: 64 }) verifierHash: string;
  @Column({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt: Date;
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 }) expiresAt: Date;
  @Column({ name: 'attempt_count', default: 0 }) attemptCount: number;
  @Column({ name: 'consumed_at', type: 'datetime', precision: 3, nullable: true }) consumedAt: Date | null;
}
@Entity('destruction_jobs')
@Index(['status', 'runAt', 'leaseExpiry'])
export class DestructionJob {
  @PrimaryColumn({ name: 'request_id', type: 'varchar', length: 36 }) requestId: string;
  @Column({ name: 'run_at', type: 'datetime', precision: 3 }) runAt: Date;
  @Column({ length: 32 }) status: string;
  @Column({ name: 'lease_owner', type: 'varchar', length: 36, nullable: true }) leaseOwner: string | null;
  @Column({ name: 'lease_expiry', type: 'datetime', precision: 3, nullable: true }) leaseExpiry: Date | null;
  @Column({ default: 0 }) attempts: number;
  @Column({ type: 'json', nullable: true }) checkpoint: any;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError: string | null;
}
@Entity('destruction_backup_dispositions')
@Index(['status', 'checkedAt'])
@Index(['requestId', 'documentId', 'target'], { unique: true })
export class DestructionBackupDisposition {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ name: 'request_id', length: 36 }) requestId: string;
  @Column({ name: 'document_id', length: 36 }) documentId: string;
  @Column({ length: 16 }) target: string;
  @Column({ type: 'json' }) objects: any;
  @Column({ length: 32 }) status: string;
  @Column({ name: 'excluded_at', type: 'datetime', precision: 3, nullable: true }) excludedAt: Date | null;
  @Column({ name: 'purge_due_at', type: 'datetime', precision: 3 }) purgeDueAt: Date;
  @Column({ name: 'purged_at', type: 'datetime', precision: 3, nullable: true }) purgedAt: Date | null;
  @Column({ name: 'checked_at', type: 'datetime', precision: 3, nullable: true }) checkedAt: Date | null;
  @Column({ type: 'json', nullable: true }) evidence: any;
  @Column({ type: 'text', nullable: true }) error: string | null;
}
@Entity('destruction_idempotency')
export class DestructionIdempotency {
  @PrimaryColumn({ type: 'varchar', length: 64 }) id: string;
  @Column({ length: 64 }) digest: string;
  @Column({ type: 'json' }) result: any;
  @Column({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt: Date;
}
export const destructionEntities = [DestructionRequest, DestructionItem, DestructionAttachment, DestructionAttachmentContent,
  DestructionApproval, DestructionOtpChallenge, DestructionJob, DestructionBackupDisposition, DestructionIdempotency];
