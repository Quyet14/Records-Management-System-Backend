import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Guard giới hạn truy cập theo IP / dải mạng nội bộ.
 *
 * Cấu hình trong .env:
 *   IP_WHITELIST=127.0.0.1,::1,192.168.1.0/24,10.0.0.0/8
 *
 * - Nếu IP_WHITELIST không được set hoặc rỗng → cho phép tất cả (tương thích ngược).
 * - Hỗ trợ: IPv4 đơn, IPv6 đơn, CIDR IPv4 (ví dụ 192.168.1.0/24).
 * - Lấy IP thực từ X-Forwarded-For (khi đứng sau Nginx reverse proxy).
 */
@Injectable()
export class IpWhitelistGuard implements CanActivate {
  private readonly logger = new Logger(IpWhitelistGuard.name);
  private readonly whitelist: string[];

  constructor(private configService: ConfigService) {
    const raw = this.configService.get<string>('IP_WHITELIST') ?? '';
    this.whitelist = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  canActivate(context: ExecutionContext): boolean {
    // Nếu chưa cấu hình whitelist → cho phép tất cả
    if (this.whitelist.length === 0) return true;

    const req: Request = context.switchToHttp().getRequest();
    const ip = this.extractIp(req);

    const allowed = this.whitelist.some((entry) => this.matchIp(ip, entry));

    if (!allowed) {
      this.logger.warn(`IP bị chặn: ${ip}`);
      throw new ForbiddenException(
        'Truy cập bị từ chối: IP của bạn không được phép truy cập hệ thống này.',
      );
    }

    return true;
  }

  // ─── Helpers ─────────────────────────────────────────────

  private extractIp(req: Request): string {
    // X-Forwarded-For: client, proxy1, proxy2 — lấy phần tử đầu tiên
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return first.split(',')[0].trim();
    }
    return req.socket?.remoteAddress ?? req.ip ?? '';
  }

  private matchIp(ip: string, entry: string): boolean {
    // Chuẩn hoá IPv6 loopback
    const normalizedIp = ip.replace(/^::ffff:/, '');

    if (entry.includes('/')) {
      return this.matchCidr(normalizedIp, entry);
    }
    return normalizedIp === entry || ip === entry;
  }

  /** So khớp CIDR IPv4 — ví dụ 192.168.1.0/24 */
  private matchCidr(ip: string, cidr: string): boolean {
    try {
      const [range, bitsStr] = cidr.split('/');
      const bits = parseInt(bitsStr, 10);
      const mask = ~(0xffffffff >>> bits) >>> 0;

      const ipNum = this.ipToNum(ip);
      const rangeNum = this.ipToNum(range);

      if (ipNum === null || rangeNum === null) return false;
      return (ipNum & mask) === (rangeNum & mask);
    } catch {
      return false;
    }
  }

  private ipToNum(ip: string): number | null {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return null;
    }
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }
}
