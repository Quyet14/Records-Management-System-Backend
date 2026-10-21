import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DestructionInfrastructure } from './destruction.infrastructure';
import { fail } from './destruction.rules';

export interface Barrier { sessionId: string | null; sourceDirectory: string; operation: 'backup' | 'restore' }
/** Also used by the independent CLI backup/restore commands after npm run build. */
export async function beginBarrier(manager: { query: (sql: string) => Promise<any> }, gateway: DestructionInfrastructure,
  archiveDir: string, operation: 'backup' | 'restore' = 'backup'): Promise<Barrier> {
  const exists = await manager.query("SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'destruction_requests'");
  const history = exists.length ? await manager.query('SELECT 1 AS present FROM destruction_requests LIMIT 1') : [];
  if (!history.length && !process.env.DESTRUCTION_GATEWAY_URL && process.env.DESTRUCTION_ENABLED !== 'true')
    return { sessionId: null, sourceDirectory: archiveDir, operation };
  const receipt = await gateway.call(`${operation}/begin`, { operationId: randomUUID() });
  if (!receipt.sessionId || receipt.maintenanceProtected !== true)
    fail(503, 'BACKUP_BARRIER_UNAVAILABLE', 'Chưa xác nhận khóa an toàn sao lưu/khôi phục.');
  if (operation === 'restore') return { sessionId: receipt.sessionId, sourceDirectory: archiveDir, operation };
  if (receipt.exclusionsApplied !== true || receipt.snapshotStable !== true || typeof receipt.sourceDirectory !== 'string'
    || !process.env.DESTRUCTION_BACKUP_STAGING_ROOT)
    fail(503, 'BACKUP_EXCLUSION_UNCONFIRMED', 'Chưa xác nhận tập sao lưu đã loại nội dung bị hủy.');
  const root = fs.realpathSync(process.env.DESTRUCTION_BACKUP_STAGING_ROOT);
  const source = fs.realpathSync(receipt.sourceDirectory);
  const relative = path.relative(root, source);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(source).isDirectory())
    fail(503, 'UNSAFE_BACKUP_SOURCE', 'Nguồn sao lưu không nằm trong vùng staging được cấu hình.');
  const inspect = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail(503, 'UNSAFE_BACKUP_SOURCE', 'Tập sao lưu không được chứa liên kết tượng trưng.');
      if (entry.isDirectory()) inspect(path.join(dir, entry.name));
    }
  };
  inspect(source);
  return { sessionId: receipt.sessionId, sourceDirectory: source, operation };
}
export async function endBarrier(gateway: DestructionInfrastructure, barrier: Barrier, success: boolean) {
  if (!barrier.sessionId) return;
  if (barrier.operation === 'restore') {
    // A failed restore deliberately keeps maintenance active; no publishing on an unconfirmed result.
    if (!success) return;
    const applied = await gateway.call('restore/apply-tombstones', { sessionId: barrier.sessionId });
    if (applied.applied !== true || applied.verified !== true || !applied.evidenceId)
      fail(503, 'RESTORE_TOMBSTONES_UNCONFIRMED', 'Chưa áp lại tombstone; hệ thống phải tiếp tục ở chế độ bảo trì.');
  }
  const ended = await gateway.call(`${barrier.operation}/end`, { sessionId: barrier.sessionId, success });
  if (ended.closed !== true) fail(503, 'BACKUP_BARRIER_UNCONFIRMED', 'Chưa xác nhận hoàn tất phiên sao lưu/khôi phục.');
}
