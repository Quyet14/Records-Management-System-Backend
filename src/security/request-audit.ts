import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { DataSource, EntitySubscriberInterface, EventSubscriber, InsertEvent } from 'typeorm';
import { Logger } from '@nestjs/common';
import { AuditLog } from '../entities/audit-log.entity';

interface AuditContext { requestId: string; ip: string; }
const context = new AsyncLocalStorage<AuditContext>();
@EventSubscriber()
export class AuditContextSubscriber implements EntitySubscriberInterface<AuditLog> {
  listenTo() { return AuditLog; }
  beforeInsert(event: InsertEvent<AuditLog>) {
    if (!event.entity) return;
    event.entity.metadata = { ...event.entity.metadata, ...context.getStore() };
  }
}
export function requestAuditMiddleware(db: DataSource) {
  const logger = new Logger('SecurityAudit');
  return (req: any, res: any, next: () => void) => {
    const requestId = randomUUID(), ip = String(req.ip || req.socket?.remoteAddress || '').slice(0, 64);
    let recorded = false;
    const record = () => {
      if (recorded) return; recorded = true;
      const status = res.writableFinished ? res.statusCode : 499;
      // Never persist query strings, headers, request/response bodies or URL tokens.
      const metadata = { requestId, ip, method: req.method,
        route: req.route?.path || 'unmatched', status, result: status < 400 ? 'success' : 'failure',
        resourceId: /^[0-9a-f-]{36}$/i.test(req.params?.id || '') ? req.params.id : undefined };
      db.getRepository(AuditLog).insert({ id: randomUUID(), actor: req.user?.id ? { id: req.user.id } : undefined,
        action: 'http_request', metadata: metadata as any }).catch(() => logger.error(`Không ghi được audit HTTP; requestId=${requestId}, status=${status}`));
      if ((req.path?.startsWith('/auth/') && status >= 400) || status === 429)
        logger.warn(`Sự kiện xác thực/giới hạn truy cập: requestId=${requestId}, ip=${ip}, status=${status}`);
    };
    res.once('finish', record); res.once('close', record);
    context.run({ requestId, ip }, next);
  };
}
