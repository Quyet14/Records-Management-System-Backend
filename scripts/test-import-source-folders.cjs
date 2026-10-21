// Enumeration only: isolated temporary files, no DB, antivirus, encryption or import writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importExclusions, findImportPdfs } = require('./data-pipeline');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-import-source-'));
const createFile = relative => {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, 'TEST ONLY: enumeration fixture');
  return filename;
};
try {
  const wanted = [createFile('source.pdf'), createFile('records/nested/another.PDF'), createFile('destruction-state-old/legitimate.pdf')];
  const config = {
    UPLOAD_STAGING_DIR: path.join(root, 'uploads/staging'),
    UPLOAD_ARCHIVE_DIR: path.join(root, 'uploads/archive'),
    PERSONAL_STORAGE_DIR: path.join(root, 'uploads/personal'),
    BACKUP_DIR: path.join(root, 'uploads/backup'),
    DESTRUCTION_STATE_DIR: path.join(root, 'destruction-state'),
    DESTRUCTION_BACKUP_STAGING_ROOT: path.join(root, 'destruction-backup-staging'),
    BACKUP_LOCAL_TARGETS: path.join(root, 'backup-mirror'),
    ARCHIVE_KEY_FILE: path.join(root, 'secrets/archive-keys.json'),
    DESTRUCTION_LOCAL_CONFIG: path.join(root, 'policy.json'),
  };
  createFile('destruction-state/scan-8DatZX/attachment.pdf');
  for (const directory of ['uploads/staging', 'uploads/archive', 'uploads/personal', 'uploads/backup',
    'destruction-backup-staging', 'backup-mirror', 'policy-backup', 'secrets']) createFile(`${directory}/internal.pdf`);
  createFile('records/readme.txt');
  fs.writeFileSync(config.DESTRUCTION_LOCAL_CONFIG, JSON.stringify({ targets: [{ root: path.join(root, 'policy-backup') }] }));
  let linked = false;
  try {
    fs.symlinkSync(config.DESTRUCTION_STATE_DIR, path.join(root, 'records/state-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
  const exclusions = importExclusions(config);
  assert.deepEqual(findImportPdfs(root, exclusions).sort(), wanted.sort());
  assert.throws(() => findImportPdfs(config.DESTRUCTION_STATE_DIR, exclusions), /inside internal storage/);
  assert.throws(() => findImportPdfs(config.UPLOAD_ARCHIVE_DIR, exclusions), /inside internal storage/);
  if (linked) assert.throws(() => findImportPdfs(path.join(root, 'records/state-alias'), exclusions), /inside internal storage/);
  assert.throws(() => findImportPdfs(path.join(root, 'missing'), exclusions), /does not exist/);
  assert.throws(() => findImportPdfs(wanted[0], exclusions), /point to a folder/);
  assert.deepEqual(findImportPdfs(path.join(root, 'records/nested'), exclusions), [path.join(root, 'records/nested/another.PDF')]);
  console.log('PASS: nested source PDFs remain eligible; internal scanner/state, archive, staging, personal, backup targets, secrets and aliases are excluded without deleting files.');
} finally {
  const resolved = path.resolve(root), temporary = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temporary + path.sep) || !path.basename(resolved).startsWith('lths-import-source-')) throw Error('Unsafe test cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
}
