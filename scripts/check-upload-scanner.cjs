// Real scan of an isolated, harmless PDF probe; no database or archive is touched.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PDFDocument } = require('pdf-lib');
const { scanUploadForViruses } = require('../dist/common/upload-virus-scanner');

async function main() {
  console.log('Provider:', process.env.UPLOAD_SCANNER || process.env.DESTRUCTION_SCANNER || 'clamav');
  console.log('Run this check as the same account that runs the backend.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lths-scanner-check-'));
  const filename = path.join(root, 'harmless-probe.pdf');
  try {
    const pdf = await PDFDocument.create(); pdf.addPage();
    await fs.writeFile(filename, await pdf.save());
    await scanUploadForViruses(filename);
    console.log('PASS: scanner accepted the harmless PDF probe.');
  } finally {
    await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(root);
  }
}
main().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; });
