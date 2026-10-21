import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, LessThan, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Document, DocumentStatus } from '../entities/document.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { OtpCode } from '../entities/otp-code.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { AuthCaptcha } from '../entities/auth-captcha.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { DestructionInfrastructure } from '../destruction/destruction.infrastructure';
import { beginBarrier, endBarrier, Barrier } from '../destruction/backup-barrier';
import { archiveChecksum } from '../common/archive-crypto';
import { PersonalFile } from '../entities/personal-file.entity';
import { DocumentVersion } from '../entities/document-version.entity';

export interface ChecksumResult {
  documentId: string;
  filename: string;
  expected: string;
  actual: string | null;
  ok: boolean;
  error?: string;
}

export interface BackupResult {
  success: boolean;
  backupPath?: string;
  filesCount?: number;
  totalBytes?: number;
  error?: string;
  timestamp: string;
}

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);
  private readonly archiveDir = process.env.UPLOAD_ARCHIVE_DIR || './storage/archive';
  private readonly backupDir  = process.env.BACKUP_DIR || './storage/backup';

  constructor(
    @InjectRepository(Document)     private docRepo: Repository<Document>,
    @InjectRepository(RefreshToken) private rtRepo: Repository<RefreshToken>,
    @InjectRepository(OtpCode)      private otpRepo: Repository<OtpCode>,
    @InjectRepository(AuditLog)     private auditRepo: Repository<AuditLog>,
    private dataSource: DataSource,
    private destructionInfrastructure: DestructionInfrastructure,
  ) {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  // ─── Tổng quan hệ thống ───────────────────────────────────
  async getSystemStatus() {
    const archiveFiles  = this.listArchiveFiles();
    const totalDiskBytes = archiveFiles.reduce((s, f) => s + f.size, 0);

    const [storedDocs, pendingDocs] = await Promise.all([
      this.docRepo.count({ where: { status: DocumentStatus.STORED } }),
      this.docRepo.count({ where: { status: DocumentStatus.PENDING } }),
    ]);

    return {
      archive: {
        path: path.resolve(this.archiveDir),
        totalFiles: archiveFiles.length,
        totalBytes: totalDiskBytes,
      },
      database: {
        storedDocuments: storedDocs,
        pendingDocuments: pendingDocs,
      },
      uptime: process.uptime(),
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Kiểm tra checksum toàn bộ kho ───────────────────────
  async verifyChecksums(): Promise<{ results: ChecksumResult[]; errors: number }> {
    const docs = await this.docRepo.find({
      where: [{ status: DocumentStatus.STORED }, { status: DocumentStatus.APPROVED }, { status: DocumentStatus.PENDING }],
      relations: ['file'],
    });

    const results: ChecksumResult[] = [];

    for (const doc of docs) {
      if (doc.destructionStartedAt) continue;

      const result: ChecksumResult = {
        documentId: doc.id,
        filename: doc.originalFilename,
        expected: doc.sha256Checksum || '',
        actual: null,
        ok: false,
      };

      try {
        const filename = doc.file?.storageKey || doc.storagePath;
        if (!doc.sha256Checksum) result.error = 'Thiếu checksum tin cậy';
        else if (!fs.existsSync(filename)) {
          result.error = 'File không tồn tại trên disk';
        } else {
          result.actual = await archiveChecksum(filename, doc.sha256Checksum);
          result.ok = result.actual === doc.sha256Checksum;
          if (!result.ok) result.error = 'Checksum không khớp';
        }
      } catch (err) {
        result.error = (err as Error).message;
      }

      results.push(result);
    }

    const personal = await this.dataSource.getRepository(PersonalFile).find();
    const versions = await this.dataSource.getRepository(DocumentVersion).find({ relations: ['document'] });
    for (const record of [...personal.map(f => ({ id: f.id, name: f.originalFilename, filename: f.storagePath, hash: f.sha256Checksum })),
      ...versions.filter(v => v.document?.status !== DocumentStatus.DESTROYED && !v.document?.destructionStartedAt)
        .map(v => ({ id: v.document?.id || v.id, name: `version-${v.version}`, filename: v.storagePath, hash: v.sha256Checksum }))]) {
      const result: ChecksumResult = { documentId: record.id, filename: record.name, expected: record.hash || '', actual: null, ok: false };
      try {
        if (!record.hash) result.error = 'Thiếu checksum tin cậy';
        else { result.actual = await archiveChecksum(record.filename, record.hash); result.ok = result.actual === record.hash; }
      } catch { result.error = 'Không đọc được file hoặc xác thực mã hóa/checksum thất bại'; }
      results.push(result);
    }

    const errors = results.filter(r => !r.ok).length;
    if (errors > 0) {
      this.logger.warn(`Kiểm tra checksum: ${errors}/${results.length} file có vấn đề`);
    }
    await this.auditRepo.save(this.auditRepo.create({ action: 'integrity_check', metadata: { checked: results.length, errors,
      result: errors ? 'failure' : 'success', failedIds: results.filter(r => !r.ok).map(r => r.documentId).slice(0, 100) } }));

    return { results, errors };
  }

  // ─── Backup: sao chép toàn bộ archive sang thư mục backup ─
  async runBackup(): Promise<BackupResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destDir = path.join(this.backupDir, `backup_${timestamp}`);
    let barrier: Barrier | undefined;
    let success = false;

    try {
      barrier = await beginBarrier(this.dataSource.manager, this.destructionInfrastructure, this.archiveDir);
      fs.mkdirSync(destDir, { recursive: true });

      const files = this.listFilesRecursive(barrier.sourceDirectory);
      let totalBytes = 0;

      for (const f of files) {
        const dest = path.join(destDir, f.relativePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f.path, dest);
        totalBytes += f.size;
      }

      const result: BackupResult = {
        success: true,
        backupPath: destDir,
        filesCount: files.length,
        totalBytes,
        timestamp,
      };

      await endBarrier(this.destructionInfrastructure, barrier, true);
      success = true;
      this.logger.log(`Backup thành công: ${files.length} files → ${destDir}`);
      return result;
    } catch (err) {
      this.logger.error(`Backup thất bại: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message, timestamp };
    } finally {
      if (barrier && !success) {
        try { await endBarrier(this.destructionInfrastructure, barrier, false); }
        catch { this.logger.error('Không thể đóng phiên sao lưu an toàn; cần kiểm tra vận hành.'); }
      }
    }
  }

  // ─── Kiểm thử khôi phục (restore-test) ───────────────────
  async testRestore(): Promise<{ success: boolean; checkedFiles: number; errors: string[] }> {
    const backupDirs = fs.readdirSync(this.backupDir)
      .map(name => path.join(this.backupDir, name))
      .filter(p => fs.statSync(p).isDirectory())
      .sort()
      .reverse();  // lấy backup mới nhất

    if (backupDirs.length === 0) {
      return { success: false, checkedFiles: 0, errors: ['Không có backup nào để kiểm thử'] };
    }

    const latestBackup = backupDirs[0];
    const files = this.listFilesRecursive(latestBackup);
    const errors: string[] = [];

    for (const file of files) {
      const backupFile = file.path;
      const filename = file.relativePath;
      try {
        const checksum = await this.computeChecksum(backupFile);
        if (!checksum) errors.push(`${filename}: không đọc được file`);
      } catch (err) {
        errors.push(`${filename}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Restore-test: ${files.length} files từ ${latestBackup}, ${errors.length} lỗi`);
    return { success: errors.length === 0, checkedFiles: files.length, errors };
  }

  // ─── Health check ─────────────────────────────────────────
  async getHealth() {
    const start = Date.now();

    // Kiểm tra DB
    let dbStatus = 'ok';
    let dbLatencyMs = 0;
    try {
      const t0 = Date.now();
      await this.dataSource.query('SELECT 1');
      dbLatencyMs = Date.now() - t0;
    } catch {
      dbStatus = 'error';
    }

    // Kiểm tra File Storage
    let storageStatus = 'ok';
    let storageInfo: any = {};
    try {
      const files = this.listArchiveFiles();
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      storageInfo = { totalFiles: files.length, totalBytes };
    } catch {
      storageStatus = 'error';
    }

    return {
      status:    dbStatus === 'ok' && storageStatus === 'ok' ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime:    Math.floor(process.uptime()),
      version:   process.env.npm_package_version ?? '1.0.0',
      services: {
        api:     { status: 'ok', latencyMs: Date.now() - start },
        database: { status: dbStatus, latencyMs: dbLatencyMs },
        storage:  { status: storageStatus, ...storageInfo },
      },
    };
  }

  // ─── Audit logs ───────────────────────────────────────────
  async getAuditLogs(query: {
    action?: string;
    userId?: string;
    documentId?: string;
    page: number;
    limit: number;
  }) {
    const qb = this.auditRepo
      .createQueryBuilder('log')
      .leftJoinAndSelect('log.actor', 'actor')
      .leftJoinAndSelect('log.document', 'document')
      .orderBy('log.createdAt', 'DESC');

    if (query.action) {
      qb.andWhere('log.action = :action', { action: query.action });
    }
    if (query.userId) {
      qb.andWhere('actor.id = :userId', { userId: query.userId });
    }
    if (query.documentId) {
      qb.andWhere('document.id = :documentId', { documentId: query.documentId });
    }

    const { page, limit } = query;
    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data: data.map(log => ({
        id:         log.id,
        action:     log.action,
        actorId:    (log.actor as any)?.id,
        actorName:  (log.actor as any)?.fullName ?? (log.actor as any)?.email,
        documentId: (log.document as any)?.id,
        documentTitle: (log.document as any)?.title || (log.document as any)?.originalFilename,
        metadata:   log.metadata,
        createdAt:  log.createdAt,
      })),
      total, page, limit,
    };
  }

  // ─── Cron jobs ────────────────────────────────────────────

  /** Backup tự động — mỗi ngày lúc 2 giờ sáng */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async scheduledBackup() {
    this.logger.log('Cron: bắt đầu backup tự động...');
    await this.runBackup();
  }

  /** Kiểm tra checksum — mỗi tuần Chủ Nhật lúc 3 giờ sáng */
  @Cron('0 3 * * 0', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledChecksumVerify() {
    this.logger.log('Cron: kiểm tra checksum toàn bộ kho...');
    const { errors } = await this.verifyChecksums();
    if (errors > 0) {
      this.logger.error(`Cron checksum: phát hiện ${errors} file có vấn đề!`);
    }
  }

  /** Dọn refresh token hết hạn — mỗi ngày lúc 4 giờ sáng */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpiredTokens() {
    const result = await this.rtRepo
      .createQueryBuilder()
      .delete()
      .where('expires_at < :now', { now: new Date() })
      .execute();
    this.logger.log(`Cron: đã xoá ${result.affected ?? 0} refresh token hết hạn`);
    await this.dataSource.getRepository(AuthSession).delete({ expiresAt: LessThan(new Date()) });
    await this.dataSource.getRepository(AuthCaptcha).delete({ expiresAt: LessThan(new Date()) });
  }

  /** Dọn OTP hết hạn — mỗi ngày lúc 5 giờ sáng */
  @Cron('0 5 * * *')
  async purgeExpiredOtp() {
    await this.dataSource.query('DELETE FROM security_rate_limits WHERE expires_ms < UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AND blocked_ms < UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000');
    const result = await this.otpRepo
      .createQueryBuilder()
      .delete()
      .where('expires_at < :now OR is_used = 1', { now: new Date() })
      .execute();
    if ((result.affected ?? 0) > 0) {
      this.logger.log(`Cron: đã xoá ${result.affected} OTP hết hạn`);
    }
  }

  /** Dọn record pending mà file staging đã mất — mỗi ngày lúc 5 giờ sáng */
  @Cron('0 5 * * *')
  async purgeOrphanedPendingRecords() {
    const docs = await this.docRepo.find({
      where: { status: DocumentStatus.PENDING },
      select: ['id', 'storagePath', 'originalFilename'],
    });

    let count = 0;
    for (const doc of docs) {
      const absPath = path.isAbsolute(doc.storagePath)
        ? doc.storagePath
        : path.resolve(process.cwd(), doc.storagePath);

      if (!fs.existsSync(absPath)) {
        await this.docRepo.update(doc.id, {
          status: DocumentStatus.REJECTED,
          rejectReason: 'File tạm thời không còn tồn tại (tự động dọn dẹp)',
        });
        count++;
        this.logger.warn(`Cron: đánh dấu rejected cho "${doc.originalFilename}" — file mất`);
      }
    }

    if (count > 0) {
      this.logger.warn(`Cron: đã dọn ${count} record pending không có file.`);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────
  private listArchiveFiles(): { path: string; relativePath: string; size: number }[] {
    if (!fs.existsSync(this.archiveDir)) return [];
    return this.listFilesRecursive(this.archiveDir);
  }

  private listFilesRecursive(rootDir: string): { path: string; relativePath: string; size: number }[] {
    const files: { path: string; relativePath: string; size: number }[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }

        if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          files.push({
            path: fullPath,
            relativePath: path.relative(rootDir, fullPath),
            size: stat.size,
          });
        }
      }
    };

    walk(rootDir);
    return files;
  }

  private computeChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }
}
