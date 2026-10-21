import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey } from 'typeorm';
import { destructionEntities } from '../entities/destruction.entity';

export const DESTRUCTION_REQUIRED_TRIGGERS = [
  'destruction_documents_update', 'destruction_documents_delete', 'destruction_documents_insert',
  ...['insert', 'update', 'delete'].map(op => `destruction_versions_${op}`),
  ...['update', 'delete'].flatMap(op => [
    `destruction_files_${op}`, `destruction_audit_${op}`,
    ...['destruction_attachments', 'destruction_attachment_content', 'destruction_approvals', 'destruction_idempotency'].map(table => `${table}_${op}`),
  ]),
  'destruction_items_snapshot', 'destruction_items_delete', 'destruction_requests_delete', 'destruction_requests_binding',
];

/** MySQL DDL commits implicitly. Run on a backed-up staging database before production. */
export class DestructionWorkflow1792368000000 implements MigrationInterface {
  transaction = false;

  async up(q: QueryRunner): Promise<void> {
    const documents = await q.getTable('documents');
    if (!documents) throw new Error('documents table is required');
    const status = documents.findColumnByName('status');
    if (!status) throw new Error('documents.status is required');
    if (status.type === 'enum' && !status.enum?.includes('destroyed')) {
      const defaultValue = typeof status.default === 'string' && status.default.startsWith("'") && status.default.endsWith("'")
        ? status.default.slice(1, -1)
        : status.default;
      await q.changeColumn('documents', status, new TableColumn({
        ...status,
        enum: [...(status.enum ?? []), 'destroyed'],
        default: defaultValue,
      }));
    }
    const columns = [
      new TableColumn({ name: 'retention_until', type: 'datetime', precision: 3, isNullable: true }),
      new TableColumn({ name: 'legal_hold', type: 'tinyint', default: '0' }),
      new TableColumn({ name: 'destroyed_at', type: 'datetime', precision: 3, isNullable: true }),
      new TableColumn({ name: 'destruction_started_at', type: 'datetime', precision: 3, isNullable: true }),
      new TableColumn({ name: 'destruction_request_id', type: 'varchar', length: '36', isNullable: true }),
    ];
    for (const column of columns) if (!await q.hasColumn('documents', column.name)) await q.addColumn('documents', column);
    for (const entity of destructionEntities) {
      const metadata = q.connection.getMetadata(entity);
      await q.createTable(Table.create(metadata, q.connection.driver), true);
    }
    const references: [string, string, string, string][] = [
      ['destruction_requests', 'created_by', 'users', 'id'], ['destruction_requests', 'completed_by', 'users', 'id'],
      ['destruction_items', 'request_id', 'destruction_requests', 'id'], ['destruction_items', 'document_id', 'documents', 'id'],
      ['destruction_attachments', 'request_id', 'destruction_requests', 'id'], ['destruction_attachments', 'uploaded_by', 'users', 'id'],
      ['destruction_attachment_content', 'attachment_id', 'destruction_attachments', 'id'],
      ['destruction_otp_challenges', 'request_id', 'destruction_requests', 'id'], ['destruction_otp_challenges', 'actor_id', 'users', 'id'],
      ['destruction_approvals', 'request_id', 'destruction_requests', 'id'], ['destruction_approvals', 'user_id', 'users', 'id'],
      ['destruction_approvals', 'otp_challenge_id', 'destruction_otp_challenges', 'id'],
      ['destruction_jobs', 'request_id', 'destruction_requests', 'id'],
      ['destruction_backup_dispositions', 'request_id', 'destruction_requests', 'id'],
      ['destruction_backup_dispositions', 'document_id', 'documents', 'id'],
      ['documents', 'destruction_request_id', 'destruction_requests', 'id'],
    ];
    for (const [table, column, target, targetColumn] of references) {
      const name = `fk_${table}_${column}`;
      const existing = await q.getTable(table);
      if (!existing?.foreignKeys.some(key => key.name === name)) {
        // Match legacy UUID column collations before creating cross-table FKs.
        const [definition] = await q.query(`SHOW FULL COLUMNS FROM \`${target}\` WHERE Field = ?`, [targetColumn]);
        if (!definition || !/^varchar\(36\)$/i.test(definition.Type)) throw new Error(`Expected UUID varchar(36): ${target}.${targetColumn}`);
        const collation = definition.Collation;
        if (collation && /^[a-zA-Z0-9_]+$/.test(collation)) {
          const nullable = existing!.findColumnByName(column)!.isNullable;
          await q.query(`ALTER TABLE \`${table}\` MODIFY \`${column}\` varchar(36) COLLATE ${collation} ${nullable ? 'NULL' : 'NOT NULL'}`);
        }
        await q.createForeignKey(table, new TableForeignKey({ name, columnNames: [column], referencedTableName: target,
          referencedColumnNames: [targetColumn], onDelete: 'RESTRICT', onUpdate: 'RESTRICT' }));
      }
    }
    const immutable = ['original_filename', 'title', 'summary', 'description', 'reference_no', 'document_number', 'issuing_unit',
      'organizing_body', 'received_date', 'author_name', 'department_id', 'document_type_id', 'uploader_id', 'file_id', 'storage_path',
      'sha256_checksum', 'file_size_bytes', 'version', 'security_level', 'classification_value', 'document_date', 'patient_death_date', 'retention_until', 'expires_at', 'visibility'];
    const changed = immutable.map(column => `NOT (OLD.\`${column}\` <=> NEW.\`${column}\`)`).join(' OR ');
    await this.trigger(q, 'destruction_documents_update', 'BEFORE UPDATE ON documents', `
      IF OLD.destruction_started_at IS NOT NULL AND NOT (OLD.legal_hold <=> NEW.legal_hold) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_STARTED_LEGAL_HOLD_LOCKED';
      END IF;
      IF OLD.destruction_request_id IS NOT NULL AND (${changed}) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DOCUMENT_FROZEN_FOR_DESTRUCTION';
      END IF;
      IF OLD.status = 'destroyed' AND (NEW.status != 'destroyed' OR NOT (OLD.destroyed_at <=> NEW.destroyed_at)
          OR NOT (OLD.destruction_request_id <=> NEW.destruction_request_id)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTROYED_DOCUMENT_IMMUTABLE';
      END IF;
      IF OLD.destruction_started_at IS NOT NULL AND NOT (OLD.destruction_started_at <=> NEW.destruction_started_at) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_STARTED_IMMUTABLE';
      END IF;
      IF OLD.destruction_request_id IS NULL AND (NOT (OLD.file_id <=> NEW.file_id) OR OLD.storage_path != NEW.storage_path)
        AND EXISTS (SELECT 1 FROM documents d WHERE d.destruction_request_id IS NOT NULL
          AND ((NEW.file_id IS NOT NULL AND d.file_id = NEW.file_id) OR d.storage_path = NEW.storage_path)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CONTENT_CLAIMED_FOR_DESTRUCTION';
      END IF;`);
    await this.trigger(q, 'destruction_documents_delete', 'BEFORE DELETE ON documents', `
      IF OLD.destruction_request_id IS NOT NULL OR OLD.status = 'destroyed' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_METADATA_MUST_BE_RETAINED';
      END IF;`);
    await this.trigger(q, 'destruction_documents_insert', 'BEFORE INSERT ON documents', `
      IF EXISTS (SELECT 1 FROM documents d WHERE d.destruction_request_id IS NOT NULL
        AND ((NEW.file_id IS NOT NULL AND d.file_id = NEW.file_id) OR d.storage_path = NEW.storage_path)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CONTENT_CLAIMED_FOR_DESTRUCTION';
      END IF;`);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      await this.trigger(q, `destruction_versions_${operation.toLowerCase()}`, `BEFORE ${operation} ON document_versions`, `
        IF EXISTS (SELECT 1 FROM documents d WHERE d.id = ${row}.document_id AND d.destruction_request_id IS NOT NULL)
          ${operation === 'UPDATE' ? 'OR EXISTS (SELECT 1 FROM documents d WHERE d.id = OLD.document_id AND d.destruction_request_id IS NOT NULL)' : ''} THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DOCUMENT_VERSIONS_FROZEN';
        END IF;`);
    }
    for (const operation of ['UPDATE', 'DELETE']) {
      await this.trigger(q, `destruction_files_${operation.toLowerCase()}`, `BEFORE ${operation} ON files`, `
        IF EXISTS (SELECT 1 FROM documents d WHERE d.file_id = OLD.id AND d.destruction_request_id IS NOT NULL) THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_FILE_METADATA_FROZEN';
        END IF;`);
      for (const table of ['destruction_attachments', 'destruction_attachment_content', 'destruction_approvals', 'destruction_idempotency'])
        await this.trigger(q, `${table}_${operation.toLowerCase()}`, `BEFORE ${operation} ON ${table}`,
          "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_RECORD_APPEND_ONLY';");
      await this.trigger(q, `destruction_audit_${operation.toLowerCase()}`, `BEFORE ${operation} ON audit_logs`, `
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AUDIT_APPEND_ONLY';`);
    }
    await this.trigger(q, 'destruction_items_snapshot', 'BEFORE UPDATE ON destruction_items', `
      IF NOT (OLD.snapshot <=> NEW.snapshot) OR OLD.document_id != NEW.document_id OR OLD.request_id != NEW.request_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_SNAPSHOT_IMMUTABLE';
      END IF;`);
    await this.trigger(q, 'destruction_items_delete', 'BEFORE DELETE ON destruction_items',
      "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_ITEMS_RETAINED';");
    await this.trigger(q, 'destruction_requests_delete', 'BEFORE DELETE ON destruction_requests',
      "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_REQUEST_RETAINED';");
    await this.trigger(q, 'destruction_requests_binding', 'BEFORE UPDATE ON destruction_requests', `
      IF OLD.digest != REPEAT('0', 64) AND (OLD.digest != NEW.digest OR OLD.created_by != NEW.created_by
        OR OLD.required_approvals != NEW.required_approvals OR OLD.decision_number != NEW.decision_number
        OR OLD.decision_date != NEW.decision_date OR OLD.reason != NEW.reason
        OR NOT (OLD.backup_policy_snapshot <=> NEW.backup_policy_snapshot)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DESTRUCTION_APPROVED_BINDING_IMMUTABLE';
      END IF;`);
    // Deliberately no backfill from expires_at: old values may have used the upload date.
  }

  private async trigger(q: QueryRunner, name: string, event: string, body: string) {
    const existing = await q.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?', [name]);
    if (!existing.length) await q.query(`CREATE TRIGGER \`${name}\` ${event} FOR EACH ROW BEGIN ${body} END`);
  }

  async down(): Promise<void> {
    throw new Error('Destruction evidence cannot be rolled back or dropped automatically. Restore application code with schema retained.');
  }
}
