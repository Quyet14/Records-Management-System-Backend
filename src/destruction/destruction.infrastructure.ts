import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { fail, MAX_PDF_BYTES } from './destruction.rules';
import { LocalDestructionInfrastructure } from './local-infrastructure';

export interface BackupPolicy {
  version: string;
  targets: { key: string; label: string; purgeWithinDays: number; notes: string; enabled?: boolean }[];
}
export interface InfrastructureHealth {
  ready: boolean;
  otp: boolean;
  worker: boolean;
  immutableEvidence: boolean;
  malwareScanner: boolean;
  contentInventory: boolean;
  backupExclusion: boolean;
  restoreTombstones: boolean;
  backupPolicy: BackupPolicy;
}
/** Direct local integration by default; the optional gateway provider remains supported. */
@Injectable()
export class DestructionInfrastructure {
  constructor(private readonly config: ConfigService, @Optional() private readonly local?: LocalDestructionInfrastructure) {}

  provider(): string {
    return this.config.get<string>('DESTRUCTION_PROVIDER') || (this.config.get('DESTRUCTION_GATEWAY_URL') ? 'gateway' : 'local');
  }
  async guardMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.provider() === 'local' && this.local ? this.local.exclusive(operation) : operation();
  }
  maintenance(): boolean { return this.provider() === 'local' && this.local?.maintenance() === true; }
  async unavailableReasons(): Promise<string[]> {
    if (this.config.get('DESTRUCTION_ENABLED') !== 'true') return ['Chức năng hủy chưa được bật: DESTRUCTION_ENABLED=false.'];
    if (this.provider() === 'local') return this.local ? this.local.readinessReasons() : ['Chưa nạp tích hợp hủy trực tiếp.'];
    return ['Không thể xác nhận gateway hạ tầng đã sẵn sàng.'];
  }

  private settings() {
    const endpoint = this.config.get<string>('DESTRUCTION_GATEWAY_URL');
    const secret = this.config.get<string>('DESTRUCTION_GATEWAY_SECRET');
    if (!endpoint || !secret || secret.length < 32) fail(503, 'DESTRUCTION_UNAVAILABLE', 'Dịch vụ hủy hồ sơ chưa sẵn sàng.');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      fail(503, 'DESTRUCTION_UNAVAILABLE', 'Kết nối dịch vụ hủy chưa được bảo vệ.');
    return { endpoint: endpoint.replace(/\/$/, ''), secret };
  }

  async call<T = any>(operation: string, payload: any): Promise<T> {
    if (this.provider() === 'local') {
      if (!this.local) fail(503, 'LOCAL_PROVIDER_UNAVAILABLE', 'Chưa nạp tích hợp lưu trữ trực tiếp.');
      return this.local.call(operation, payload);
    }
    if (this.provider() !== 'gateway') fail(503, 'INVALID_PROVIDER', 'DESTRUCTION_PROVIDER không hợp lệ.');
    const { endpoint, secret } = this.settings();
    try {
      const response = await fetch(`${endpoint}/${operation}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error('gateway rejected');
      return await response.json() as T;
    } catch {
      fail(503, 'DESTRUCTION_INFRASTRUCTURE_ERROR', 'Không thể xác nhận kết quả từ hạ tầng hủy hồ sơ.');
    }
  }

  async health(): Promise<InfrastructureHealth | null> {
    if (this.config.get('DESTRUCTION_ENABLED') !== 'true') return null;
    try {
      const health = await this.call<InfrastructureHealth>('health', {});
      const flags = ['ready', 'otp', 'worker', 'immutableEvidence', 'malwareScanner', 'contentInventory', 'backupExclusion', 'restoreTombstones'];
      const policy = health.backupPolicy;
      if (!flags.every(flag => health[flag] === true) || typeof policy?.version !== 'string' || !policy.version.trim() || !Array.isArray(policy.targets)
        || policy.targets.length !== 3 || !['external', 'cloud', 'nas'].every(key => policy.targets.some(t => t.key === key))
        || !policy.targets.some(t => t.enabled !== false)
        || !policy.targets.every(t => typeof t.label === 'string' && !!t.label && (t.enabled === false
          ? t.purgeWithinDays === 0 && typeof t.notes === 'string' && !!t.notes.trim()
          : Number.isSafeInteger(t.purgeWithinDays) && t.purgeWithinDays > 0
            && Number.isFinite(new Date(Date.now() + t.purgeWithinDays * 86400000).getTime())))) return null;
      return health;
    } catch { return null; }
  }

  async requireReady(): Promise<InfrastructureHealth> {
    const health = await this.health();
    if (!health) fail(503, 'DESTRUCTION_UNAVAILABLE', 'Dịch vụ hủy hồ sơ chưa sẵn sàng.');
    return health;
  }

  otpHash(challengeId: string, otp: string): string {
    const secret = this.provider() === 'gateway' ? this.settings().secret
      : this.config.get<string>('DESTRUCTION_OTP_SECRET') || this.config.get<string>('JWT_SECRET');
    if (!secret || secret.length < 32) fail(503, 'OTP_SECRET_REQUIRED', 'DESTRUCTION_OTP_SECRET cần ít nhất 32 ký tự.');
    return createHmac('sha256', secret).update(`${challengeId}:${otp}`).digest('hex');
  }

  async validatePdf(file: Express.Multer.File | undefined): Promise<Express.Multer.File> {
    if (!file?.buffer?.length) fail(422, 'PDF_REQUIRED', 'Vui lòng đính kèm chứng từ PDF.');
    if (file.buffer.length > MAX_PDF_BYTES) fail(413, 'PDF_TOO_LARGE', 'Chứng từ vượt dung lượng cho phép.');
    try {
      const pdf = await PDFDocument.load(file.buffer, { ignoreEncryption: false, throwOnInvalidObject: true });
      if (pdf.getPageCount() < 1) throw new Error('empty');
    } catch { fail(422, 'INVALID_PDF', 'Chứng từ PDF không hợp lệ, bị mã hóa hoặc không thể đọc.'); }
    const scan = await this.call('scan-pdf', { bytes: file.buffer.toString('base64') });
    if (scan.clean !== true || scan.readable !== true) fail(422, 'UNSAFE_PDF', 'Chứng từ không vượt qua kiểm tra an toàn.');
    return file;
  }
}
