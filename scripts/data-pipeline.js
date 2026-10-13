/**
 * Unified data pipeline for LTHS-BACKEND.
 *
 * Commands:
 *   node scripts/data-pipeline.js import-mysql-dump
 *   node scripts/data-pipeline.js index-files
 *   node scripts/data-pipeline.js migrate-sqlserver
 *   node scripts/data-pipeline.js backup-sync
 *   node scripts/data-pipeline.js all
 *
 * Configuration is read from .env / process.env. See DATA-PIPELINE.md.
 */

require('dotenv').config();

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const COMMANDS = new Set([
  'import-mysql-dump',
  'index-files',
  'migrate-sqlserver',
  'backup-sync',
  'all',
]);

const MYSQL = {
  host: env('DB_HOST', 'MYSQL_HOST', 'localhost'),
  port: Number(env('DB_PORT', 'MYSQL_PORT', '3306')),
  database: env('DB_DATABASE', 'MYSQL_DATABASE', 'pdf_archive'),
  user: env('DB_USERNAME', 'MYSQL_USER', 'root'),
  password: env('DB_PASSWORD', 'MYSQL_PASSWORD', ''),
};

const STAGING_DIR = path.resolve(env('UPLOAD_STAGING_DIR', null, './storage/staging'));
const ARCHIVE_DIR = path.resolve(env('UPLOAD_ARCHIVE_DIR', null, './storage/archive'));
const BACKUP_DIR = path.resolve(env('BACKUP_DIR', null, './storage/backup'));
const FILE_IMPORT_SOURCES = splitList(process.env.FILE_IMPORT_SOURCES, ';');
const FILE_IMPORT_MODE = (process.env.FILE_IMPORT_MODE || 'copy').toLowerCase();
const FILE_IMPORT_STATUS = (process.env.FILE_IMPORT_STATUS || 'stored').toLowerCase();
const FILE_IMPORT_UPLOADER_ID = optionalEnv('FILE_IMPORT_UPLOADER_ID');
const FILE_IMPORT_DEPARTMENT_ID = optionalEnv('FILE_IMPORT_DEPARTMENT_ID');
const FILE_IMPORT_DOCUMENT_TYPE_ID = optionalEnv('FILE_IMPORT_DOCUMENT_TYPE_ID');
const FILE_IMPORT_DATE_SOURCE = (process.env.FILE_IMPORT_DATE_SOURCE || 'mtime').toLowerCase();
const FILE_IMPORT_UPDATE_EXISTING_DATES =
  (process.env.FILE_IMPORT_UPDATE_EXISTING_DATES || 'true').toLowerCase() === 'true';

function env(primary, fallback, defaultValue) {
  if (process.env[primary] !== undefined) return process.env[primary];
  if (fallback && process.env[fallback] !== undefined) return process.env[fallback];
  return defaultValue;
}

function optionalEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value || /^<.*>$/.test(value)) return undefined;
  return value;
}

function splitList(value, separator = ',') {
  return (value || '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function usage() {
  console.log(`Usage: node scripts/data-pipeline.js <command>

Commands:
  import-mysql-dump   Restore a .sql dump into the MySQL database
  index-files         Scan local/SAN PDF folders and create document rows
  migrate-sqlserver   Pull rows from SQL Server into MySQL
  backup-sync         Dump MySQL and sync archive/dumps to SAN/server remotes
  all                 Run import-mysql-dump, index-files, migrate-sqlserver, backup-sync
`);
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ').replace(/--password=\S+/g, '--password=****');
  console.log(`> ${printable}`);
  execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
}

async function mysqlPool() {
  return mysql.createPool({
    host: MYSQL.host,
    port: MYSQL.port,
    database: MYSQL.database,
    user: MYSQL.user,
    password: MYSQL.password,
    waitForConnections: true,
    connectionLimit: 4,
    charset: 'utf8mb4',
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function walkFiles(root) {
  const result = [];
  if (!fs.existsSync(root)) return result;

  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.isDirectory()) {
      result.push(...walkFiles(full));
    } else if (item.isFile()) {
      result.push(full);
    }
  }
  return result;
}

function isPdf(filePath) {
  return path.extname(filePath).toLowerCase() === '.pdf';
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function buildArchivePath(sourceFile, docId, fileDate) {
  const date = fileDate || new Date();
  const yyyy = String(date.getFullYear());
  const dateStr = formatDate(date);
  const timeStr = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  const dir = path.join(ARCHIVE_DIR, yyyy, dateStr);
  return path.join(dir, `${timeStr}-${docId}${path.extname(sourceFile).toLowerCase() || '.pdf'}`);
}

function formatDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dateFromPath(filePath) {
  const match = filePath.match(/(?:^|[\\/])(\d{4})-(\d{2})-(\d{2})(?:[\\/]|$)/);
  if (!match) return null;

  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getImportDate(filePath, stat) {
  if (FILE_IMPORT_DATE_SOURCE === 'birthtime') return stat.birthtime;
  if (FILE_IMPORT_DATE_SOURCE === 'path-date') return dateFromPath(filePath) || stat.mtime;
  if (FILE_IMPORT_DATE_SOURCE === 'now') return new Date();
  return stat.mtime;
}

async function importMysqlDump() {
  const dumpFile = process.env.MYSQL_DUMP_FILE;
  if (!dumpFile) throw new Error('Missing MYSQL_DUMP_FILE');
  const resolved = path.resolve(dumpFile);
  if (!fs.existsSync(resolved)) throw new Error(`Dump file not found: ${resolved}`);

  const args = [
    `--host=${MYSQL.host}`,
    `--port=${MYSQL.port}`,
    `--user=${MYSQL.user}`,
    `--password=${MYSQL.password}`,
    MYSQL.database,
  ];

  console.log(`Restoring ${resolved} into ${MYSQL.database}...`);
  const sql = fs.readFileSync(resolved);
  const child = require('child_process').spawnSync('mysql', args, {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (child.status !== 0) throw new Error(`mysql restore failed with exit code ${child.status}`);
}

async function insertDocument(pool, input) {
  const id = input.id || crypto.randomUUID();
  const importedAt = input.importedAt || new Date();
  const approvedAt = input.approvedAt || (input.status === 'stored' ? importedAt : null);
  const params = {
    id,
    originalFilename: input.originalFilename,
    title: input.title || path.basename(input.originalFilename, path.extname(input.originalFilename)),
    description: input.description || null,
    departmentId: input.departmentId || FILE_IMPORT_DEPARTMENT_ID || null,
    uploaderId: input.uploaderId || FILE_IMPORT_UPLOADER_ID,
    status: input.status || FILE_IMPORT_STATUS,
    storagePath: input.storagePath,
    sha256Checksum: input.sha256Checksum || null,
    fileSizeBytes: input.fileSizeBytes || null,
    documentTypeId: input.documentTypeId || FILE_IMPORT_DOCUMENT_TYPE_ID || null,
    documentDate: input.documentDate || (approvedAt ? formatDate(approvedAt) : null),
    createdAt: input.createdAt || importedAt,
    approvedAt,
  };

  if (!params.uploaderId) {
    throw new Error('Missing FILE_IMPORT_UPLOADER_ID or row uploaderId');
  }

  await pool.execute(
    `INSERT INTO documents (
      id, original_filename, title, description, department_id, uploader_id,
      status, storage_path, sha256_checksum, file_size_bytes,
      document_type_id, document_date, classification_value,
      review_status, created_at, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclassified', 'pending', ?, ?)
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      description = VALUES(description),
      department_id = VALUES(department_id),
      storage_path = VALUES(storage_path),
      sha256_checksum = VALUES(sha256_checksum),
      file_size_bytes = VALUES(file_size_bytes),
      document_type_id = VALUES(document_type_id),
      document_date = VALUES(document_date),
      created_at = VALUES(created_at),
      approved_at = VALUES(approved_at)`,
    [
      params.id,
      params.originalFilename,
      params.title,
      params.description,
      params.departmentId,
      params.uploaderId,
      params.status,
      params.storagePath,
      params.sha256Checksum,
      params.fileSizeBytes,
      params.documentTypeId,
      params.documentDate,
      params.createdAt,
      params.approvedAt,
    ],
  );

  return id;
}

async function indexFiles() {
  if (FILE_IMPORT_SOURCES.length === 0) {
    throw new Error('Missing FILE_IMPORT_SOURCES. Use semicolon-separated folders.');
  }
  if (!['copy', 'link'].includes(FILE_IMPORT_MODE)) {
    throw new Error('FILE_IMPORT_MODE must be copy or link');
  }

  ensureDir(STAGING_DIR);
  ensureDir(ARCHIVE_DIR);

  const pool = await mysqlPool();
  let imported = 0;
  let skipped = 0;

  try {
    for (const sourceDir of FILE_IMPORT_SOURCES.map((p) => path.resolve(p))) {
      console.log(`Scanning ${sourceDir}...`);
      const files = walkFiles(sourceDir).filter(isPdf);
      for (const file of files) {
        const checksum = await sha256(file);
        const stat = fs.statSync(file);
        const fileDate = getImportDate(file, stat);
        const [existing] = await pool.execute(
          'SELECT id FROM documents WHERE sha256_checksum = ? LIMIT 1',
          [checksum],
        );
        if (existing.length > 0) {
          if (FILE_IMPORT_UPDATE_EXISTING_DATES) {
            await pool.execute(
              `UPDATE documents
               SET document_date = ?, created_at = ?, approved_at = ?
               WHERE sha256_checksum = ?`,
              [formatDate(fileDate), fileDate, FILE_IMPORT_STATUS === 'stored' ? fileDate : null, checksum],
            );
          }
          skipped += 1;
          continue;
        }

        const id = crypto.randomUUID();
        const storagePath = FILE_IMPORT_MODE === 'copy' ? buildArchivePath(file, id, fileDate) : file;
        if (FILE_IMPORT_MODE === 'copy') {
          ensureDir(path.dirname(storagePath));
          fs.copyFileSync(file, storagePath);
        }

        await insertDocument(pool, {
          id,
          originalFilename: path.basename(file),
          storagePath,
          sha256Checksum: checksum,
          fileSizeBytes: stat.size,
          status: FILE_IMPORT_STATUS,
          documentDate: formatDate(fileDate),
          createdAt: fileDate,
          approvedAt: FILE_IMPORT_STATUS === 'stored' ? fileDate : null,
        });
        imported += 1;
      }
    }
  } finally {
    await pool.end();
  }

  console.log(`Index files done. imported=${imported}, skipped=${skipped}`);
}

async function migrateSqlServer() {
  let sql;
  try {
    sql = require('mssql');
  } catch {
    throw new Error('SQL Server migration requires package "mssql". Run: npm install mssql');
  }

  const query = process.env.SQLSERVER_DOCUMENT_QUERY;
  if (!query) throw new Error('Missing SQLSERVER_DOCUMENT_QUERY');

  const pool = await mysqlPool();
  const sqlPool = await sql.connect({
    server: process.env.SQLSERVER_HOST,
    port: Number(process.env.SQLSERVER_PORT || 1433),
    database: process.env.SQLSERVER_DATABASE,
    user: process.env.SQLSERVER_USER,
    password: process.env.SQLSERVER_PASSWORD,
    options: {
      encrypt: process.env.SQLSERVER_ENCRYPT === 'true',
      trustServerCertificate: process.env.SQLSERVER_TRUST_CERT !== 'false',
    },
  });

  let imported = 0;
  let skipped = 0;

  try {
    const result = await sqlPool.request().query(query);
    for (const row of result.recordset) {
      const storagePath = row.storagePath || row.storage_path || row.filePath || row.file_path;
      if (!storagePath || !fs.existsSync(storagePath)) {
        skipped += 1;
        continue;
      }
      const checksum = await sha256(storagePath);
      const stat = fs.statSync(storagePath);
      await insertDocument(pool, {
        originalFilename: row.originalFilename || row.original_filename || path.basename(storagePath),
        title: row.title,
        description: row.description,
        departmentId: row.departmentId || row.department_id,
        uploaderId: row.uploaderId || row.uploader_id,
        documentTypeId: row.documentTypeId || row.document_type_id,
        documentDate: row.documentDate || row.document_date,
        status: row.status || FILE_IMPORT_STATUS,
        storagePath,
        sha256Checksum: checksum,
        fileSizeBytes: row.fileSizeBytes || row.file_size_bytes || stat.size,
      });
      imported += 1;
    }
  } finally {
    await sqlPool.close();
    await pool.end();
  }

  console.log(`SQL Server migration done. imported=${imported}, skipped=${skipped}`);
}

function dumpMysql() {
  ensureDir(BACKUP_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpPath = path.join(BACKUP_DIR, `db-${MYSQL.database}-${timestamp}.sql`);
  const args = [
    `--host=${MYSQL.host}`,
    `--port=${MYSQL.port}`,
    `--user=${MYSQL.user}`,
    `--password=${MYSQL.password}`,
    '--single-transaction',
    MYSQL.database,
    `--result-file=${dumpPath}`,
  ];
  run('mysqldump', args);
  return dumpPath;
}

function backupSync() {
  const dumpPath = dumpMysql();
  const remotes = splitList(process.env.BACKUP_TARGETS || process.env.RCLONE_REMOTES, ',');
  const localTargets = splitList(process.env.BACKUP_LOCAL_TARGETS, ';');

  for (const target of localTargets) {
    const targetRoot = path.resolve(target);
    const filesTarget = path.join(targetRoot, 'files');
    const dbTarget = path.join(targetRoot, 'db-dumps');
    ensureDir(filesTarget);
    ensureDir(dbTarget);
    copyTree(ARCHIVE_DIR, filesTarget);
    fs.copyFileSync(dumpPath, path.join(dbTarget, path.basename(dumpPath)));
    console.log(`Copied backup to ${targetRoot}`);
  }

  for (const remote of remotes) {
    run('rclone', ['sync', ARCHIVE_DIR, `${remote}/files`, '--create-empty-src-dirs', '--log-level', 'INFO']);
    run('rclone', ['copy', BACKUP_DIR, `${remote}/db-dumps`, '--log-level', 'INFO']);
  }
}

function copyTree(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

async function main() {
  const command = process.argv[2];
  if (!COMMANDS.has(command)) {
    usage();
    process.exit(command ? 1 : 0);
  }

  if (command === 'import-mysql-dump' || command === 'all') await importMysqlDump();
  if (command === 'index-files' || command === 'all') await indexFiles();
  if (command === 'migrate-sqlserver' || command === 'all') await migrateSqlServer();
  if (command === 'backup-sync' || command === 'all') backupSync();
}

main().catch((err) => {
  console.error(`Data pipeline failed: ${err.message}`);
  process.exit(1);
});
