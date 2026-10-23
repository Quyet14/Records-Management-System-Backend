import * as fs from 'fs';
import * as path from 'path';

const crashLogPath = path.join(__dirname, '..', 'logs', 'crash-debug.log');
fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });

function logCrash(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(crashLogPath, line);
}

process.on('exit', (code) => logCrash(`PROCESS EXIT - code: ${code}, memoryUsage: ${JSON.stringify(process.memoryUsage())}`));
process.on('SIGTERM', () => logCrash('Received SIGTERM'));
process.on('SIGINT', () => logCrash('Received SIGINT'));
process.on('uncaughtException', (err) => {
  logCrash(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason: any) => {
  logCrash(`UNHANDLED REJECTION: ${reason?.stack || reason}`);
});

// Log memory mỗi 5 giây để theo dõi trend
setInterval(() => {
  const mem = process.memoryUsage();
  logCrash(`MEM CHECK - rss: ${(mem.rss / 1024 / 1024).toFixed(1)}MB, heapUsed: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB, heapTotal: ${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB`);
}, 5000);

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { Server } from 'http';
import { ConfigService } from '@nestjs/config';
import { authAllowedOrigins } from './auth/auth-origin.guard';
import { refreshCookieOptions } from './auth/auth-cookie';
import helmet from 'helmet';
import { DataSource } from 'typeorm';
import { validateArchiveConfiguration } from './common/archive-crypto';
import { readableRoot } from './common/readable-copy';
import { requestAuditMiddleware } from './security/request-audit';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  validateArchiveConfiguration();
  readableRoot();
  const trustedProxies = (process.env.TRUST_PROXY_CIDRS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (trustedProxies.length) app.getHttpAdapter().getInstance().set('trust proxy', trustedProxies);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(requestAuditMiddleware(app.get(DataSource)));
  if (process.env.NODE_ENV === 'production') {
    if (process.env.DB_SYNCHRONIZE === 'true') throw new Error('DB_SYNCHRONIZE must be false in production.');
    const triggers = await app.get(DataSource).query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('security_audit_update','security_audit_delete')");
    if (triggers.length !== 2) throw new Error('Apply the security migration before serving production traffic.');
    for (const query of [
      'SELECT bucket_key,hits,expires_ms,blocked_ms FROM security_rate_limits LIMIT 0',
      'SELECT last_seen_at,ip_address,user_agent FROM auth_sessions LIMIT 0',
      'SELECT failed_auth_attempts,auth_locked_until FROM users LIMIT 0',
      'SELECT sha256_checksum FROM personal_files LIMIT 0',
    ]) await app.get(DataSource).query(query);
  }
  // Shared filesystem flag is read per request by every PM2 worker, including during MySQL restore.
  const maintenanceFile = path.join(process.env.DESTRUCTION_STATE_DIR || './storage/destruction-state', 'maintenance.json');
  app.use((_req: any, res: any, next: () => void) => {
    if (fs.existsSync(maintenanceFile)) {
      res.status(503).set('Cache-Control', 'no-store').json({ code: 'RESTORE_MAINTENANCE', message: 'Hệ thống đang khôi phục và xác minh dữ liệu. Vui lòng thử lại sau.' });
      return;
    }
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // loại bỏ field lạ không khai báo trong DTO
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const authConfig = app.get(ConfigService);
  const jwtSecret = authConfig.get<string>('JWT_SECRET');
  if (process.env.NODE_ENV === 'production' && (!jwtSecret || jwtSecret.length < 32 || /doi-chuoi|changeme/i.test(jwtSecret)))
    throw new Error('Set an independent random JWT_SECRET of at least 32 characters before production startup.');
  refreshCookieOptions(authConfig); // Validate HTTPS/SameSite settings before accepting logins.
  const allowedOrigins = new Set(authAllowedOrigins(authConfig));
  if (process.env.NODE_ENV === 'production' && [...allowedOrigins].some(origin => !origin.startsWith('https://')))
    throw new Error('Production CORS_ORIGINS must use HTTPS.');
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'Idempotency-Key'],
  });

  // Allow large uploads without leaving request bodies open indefinitely.
  const requestSeconds = Number(process.env.HTTP_REQUEST_TIMEOUT_SECONDS || '3600');
  if (!Number.isSafeInteger(requestSeconds) || requestSeconds < 60 || requestSeconds > 86400)
    throw new Error('HTTP_REQUEST_TIMEOUT_SECONDS must be between 60 and 86400.');
  (app.getHttpServer() as Server).requestTimeout = requestSeconds * 1000;
  (app.getHttpServer() as Server).headersTimeout = 60000;

  const port = process.env.PORT || 3002;
  await app.listen(port, '0.0.0.0');
  console.log(`Backend đang chạy tại http://localhost:${port}`);
}
bootstrap().catch(error => { console.error('Backend startup failed:', error.message); process.exit(1); });
