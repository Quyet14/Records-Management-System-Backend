import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';
import { AuthSession } from '../entities/auth-session.entity';
import { AuthCaptcha } from '../entities/auth-captcha.entity';

export class AuthDeviceSessions1792454400000 implements MigrationInterface {
  transaction = false;
  async up(q: QueryRunner): Promise<void> {
    for (const entity of [AuthSession, AuthCaptcha])
      await q.createTable(Table.create(q.connection.getMetadata(entity), q.connection.driver), true);
    if (!await q.hasColumn('refresh_tokens', 'session_id'))
      await q.addColumn('refresh_tokens', new TableColumn({ name: 'session_id', type: 'varchar', length: '36', isNullable: true }));
    if (!await q.hasColumn('refresh_tokens', 'consumed_at'))
      await q.addColumn('refresh_tokens', new TableColumn({ name: 'consumed_at', type: 'datetime', precision: 3, isNullable: true }));
    const tokens = await q.getTable('refresh_tokens');
    if (!tokens?.indices.some(index => index.columnNames.length === 1 && index.columnNames[0] === 'session_id'))
      await q.createIndex('refresh_tokens', new TableIndex({ name: 'idx_refresh_tokens_session', columnNames: ['session_id'] }));
    const sessions = await q.getTable('auth_sessions');
    if (!sessions?.foreignKeys.some(key => key.columnNames.includes('user_id'))) {
      const [column] = await q.query("SHOW FULL COLUMNS FROM `users` WHERE Field = 'id'");
      if (!column || !/^varchar\(36\)$/i.test(column.Type) || !/^[a-zA-Z0-9_]+$/.test(column.Collation || ''))
        throw Error('users.id must be a UUID varchar(36) with a supported collation.');
      await q.query(`ALTER TABLE auth_sessions MODIFY user_id varchar(36) COLLATE ${column.Collation} NOT NULL`);
      await q.createForeignKey('auth_sessions', new TableForeignKey({ name: 'fk_auth_sessions_user',
        columnNames: ['user_id'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'CASCADE' }));
    }
    // Old tokens lack device families and cannot safely participate in rotation.
    await q.query('UPDATE refresh_tokens SET is_revoked = 1 WHERE session_id IS NULL');
    await q.query('UPDATE login_confirmations SET is_consumed = 1 WHERE is_consumed = 0');
  }
  async down(): Promise<void> { throw Error('Keep session/replay records; use a database backup for rollback.'); }
}
