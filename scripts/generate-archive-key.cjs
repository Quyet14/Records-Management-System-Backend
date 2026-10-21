// Run on the deployment host. Never prints key material or overwrites existing keys.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { within, loadArchiveKeys } = require('../dist/common/archive-crypto');
const filename = process.argv[2];
try {
  if (!filename || !path.isAbsolute(filename)) throw Error('Supply an absolute filename outside project/storage/backups/web root.');
  const parent = fs.realpathSync(path.dirname(filename));
  const target = path.join(parent, path.basename(filename));
  for (const root of [process.cwd(), process.env.UPLOAD_ARCHIVE_DIR, process.env.UPLOAD_STAGING_DIR,
    process.env.PERSONAL_STORAGE_DIR, process.env.BACKUP_DIR, process.env.WEB_ROOT,
    process.env.DESTRUCTION_STATE_DIR, process.env.DESTRUCTION_BACKUP_STAGING_ROOT].filter(Boolean)) {
    if (within(fs.existsSync(root) ? fs.realpathSync(root) : root, target)) throw Error('Key location overlaps protected project/data/web root.');
  }
  const id = randomBytes(8).toString('hex');
  fs.writeFileSync(target, JSON.stringify({ current: id, keys: { [id]: randomBytes(32).toString('base64') } }, null, 2), { flag: 'wx', mode: 0o600 });
  process.env.ARCHIVE_KEY_FILE = target;
  loadArchiveKeys();
  console.log('Key file created. On Windows restrict its ACL to the service account and administrators before enabling the app.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
