import { Module, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard, ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { UploadCleanupInterceptor } from './upload-cleanup.interceptor';

@Injectable()
export class DatabaseThrottleStorage implements ThrottlerStorage {
  private readonly logger = new Logger(DatabaseThrottleStorage.name);
  constructor(private readonly db: DataSource) {}
  async increment(key: string, ttl: number, limit: number, blockDuration: number, _name: string) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.incrementLocked(key, ttl, limit, blockDuration); }
      catch (error) {
        const driver = error?.driverError ?? error;
        if ((driver?.errno === 1213 || driver?.code === 'ER_LOCK_DEADLOCK') && attempt < 2) {
          // TypeORM rolls the failed transaction back before retrying. Never retry
          // connection/commit errors with an uncertain outcome or bypass the limit.
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1) + Math.floor(Math.random() * 20)));
          continue;
        }
        const code = String(driver?.code ?? driver?.errno ?? 'UNKNOWN_DATABASE_ERROR').slice(0, 64);
        this.logger.error(`Rate limiter storage unavailable (${code}); attempts=${attempt + 1}`);
        throw new ServiceUnavailableException({ code: 'RATE_LIMIT_STORAGE_UNAVAILABLE',
          message: 'Hệ thống đang bận kiểm tra giới hạn truy cập. Vui lòng thử lại sau.' });
      }
    }
  }

  private async incrementLocked(key: string, ttl: number, limit: number, blockDuration: number) {
    return this.db.transaction(async m => {
      // Duplicate INSERT IGNORE acquires a shared record lock. Concurrent requests
      // upgrading that lock with SELECT FOR UPDATE can deadlock. An upsert takes
      // the exclusive lock immediately and preserves the existing counter/window.
      await m.query('INSERT INTO security_rate_limits (bucket_key,hits,expires_ms,blocked_ms) VALUES (?,0,0,0) ON DUPLICATE KEY UPDATE hits=hits', [key]);
      const [row] = await m.query('SELECT *, FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000) AS now_ms FROM security_rate_limits WHERE bucket_key=? FOR UPDATE', [key]);
      const now = Number(row.now_ms);
      let hits = Number(row.hits), expiry = Number(row.expires_ms), blocked = Number(row.blocked_ms);
      if (blocked <= now) {
        if (expiry <= now || blocked > 0) { hits = 0; expiry = now + ttl; blocked = 0; }
        hits++;
        if (hits > limit) blocked = now + blockDuration;
        await m.query('UPDATE security_rate_limits SET hits=?,expires_ms=?,blocked_ms=? WHERE bucket_key=?', [hits, expiry, blocked, key]);
      }
      return { totalHits: hits, timeToExpire: Math.max(0, Math.ceil((expiry - now) / 1000)), isBlocked: blocked > now,
        timeToBlockExpire: Math.max(0, Math.ceil((blocked - now) / 1000)) };
    });
  }
}

@Module({ providers: [DatabaseThrottleStorage], exports: [DatabaseThrottleStorage] })
class DatabaseThrottleModule {}

@Module({
  imports: [ThrottlerModule.forRootAsync({
    imports: [DatabaseThrottleModule], inject: [DatabaseThrottleStorage],
    useFactory: (storage: DatabaseThrottleStorage) => ({ storage,
      // Aggregate by IP across routes. Never trust X-Forwarded-For directly.
      generateKey: (_context, tracker, name) => createHash('sha256').update(`${name}:${tracker}`).digest('hex'),
      throttlers: [
        { name: 'global', ttl: 60000, limit: 300 },
        { name: 'auth', ttl: 60000, limit: 20,
          skipIf: context => !context.switchToHttp().getRequest().path.startsWith('/auth/') },
        { name: 'files', ttl: 60000, limit: 60,
          skipIf: context => !/^\/documents\/[^/]+\/(view|download)$/.test(context.switchToHttp().getRequest().path) },
      ],
    }),
  })],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_INTERCEPTOR, useClass: UploadCleanupInterceptor }],
})
export class SecurityModule {}
