import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';

export class SecurityHardening1792540800000 implements MigrationInterface {
  async up(q: QueryRunner) {
    if (!await q.hasTable('security_rate_limits')) await q.createTable(new Table({ name: 'security_rate_limits', columns: [
      { name: 'bucket_key', type: 'varchar', length: '64', isPrimary: true },
      { name: 'hits', type: 'int', default: 0 },
      { name: 'expires_ms', type: 'bigint', default: 0 },
      { name: 'blocked_ms', type: 'bigint', default: 0 },
    ], indices: [{ name: 'IDX_security_rate_expiry', columnNames: ['expires_ms'] }] }));
    for (const operation of ['UPDATE', 'DELETE']) {
      const name = `security_audit_${operation.toLowerCase()}`;
      const existing = await q.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?', [name]);
      if (!existing.length) await q.query(`CREATE TRIGGER ${name} BEFORE ${operation} ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='AUDIT_APPEND_ONLY'`);
    }
    if (!await q.hasColumn('personal_files', 'sha256_checksum')) await q.addColumn('personal_files', new TableColumn({ name: 'sha256_checksum', type: 'varchar', length: '64', isNullable: true }));
    for (const column of [
      { name: 'last_seen_at', type: 'datetime', precision: 3, isNullable: true },
      { name: 'ip_address', type: 'varchar', length: '64', isNullable: true },
      { name: 'user_agent', type: 'varchar', length: '500', isNullable: true },
    ]) if (!await q.hasColumn('auth_sessions', column.name)) await q.addColumn('auth_sessions', new TableColumn(column));
    await q.query('UPDATE auth_sessions SET last_seen_at=created_at WHERE last_seen_at IS NULL');
    for (const column of [
      { name: 'failed_auth_attempts', type: 'int', default: '0' },
      { name: 'auth_locked_until', type: 'datetime', precision: 3, isNullable: true },
    ]) if (!await q.hasColumn('users', column.name)) await q.addColumn('users', new TableColumn(column));
  }
  async down() { throw new Error('Security evidence is retained; automatic rollback is disabled.'); }
}
