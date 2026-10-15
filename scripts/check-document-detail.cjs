// Read-only diagnosis. Run from the backend directory on the application server.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.chdir(root);
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

async function main() {
  const id = process.argv[2];
  if (!id || id === '--help') {
    console.log('Usage: node scripts/check-document-detail.cjs <document-uuid>');
    console.log('Checks the local API, compiled route and database without changing data.');
    return;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Document ID must be a UUID.');
  }

  const controller = path.join(root, 'dist/documents/documents.controller.js');
  console.log('BUILD:', fs.existsSync(controller) && /prototype, "getDetail"/.test(fs.readFileSync(controller, 'utf8'))
    ? 'GET /documents/:id exists in dist.'
    : 'Detail route missing from dist. Deploy updated source and run npm run build.');

  const url = `http://127.0.0.1:${process.env.PORT || 3002}/documents/${id}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    console.log('LOCAL API:', response.status, response.status === 401
      ? '(route responds; login required as expected)'
      : (await response.text()).slice(0, 600));
  } catch (error) {
    console.log('LOCAL API:', error.cause?.code || error.message);
  }

  require('reflect-metadata');
  const { DataSource } = require('typeorm');
  const entityDir = path.join(root, 'dist/entities');
  const entities = fs.readdirSync(entityDir)
    .filter(name => name.endsWith('.entity.js'))
    .flatMap(name => Object.values(require(path.join(entityDir, name))).filter(value => typeof value === 'function'));
  const ds = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'pdf_archive',
    charset: 'utf8mb4',
    entities,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    connectTimeout: 10000,
  });
  try {
    await ds.initialize();
    const { Document } = require(path.join(entityDir, 'document.entity.js'));
    const { DocumentsService } = require(path.join(root, 'dist/documents/documents.service.js'));
    if (typeof DocumentsService.prototype.getDetail !== 'function') {
      throw new Error('getDetail missing from compiled service. Deploy and rebuild backend.');
    }
    // Execute the actual detail query; report presence only, never document contents.
    const detail = await DocumentsService.prototype.getDetail.call(
      { docsRepo: ds.getRepository(Document) }, id, { role: 'admin' },
    );
    const fields = ['summary', 'referenceNo', 'issuingUnit', 'organizingBody', 'receivedDate',
      'documentNumber', 'securityLevel', 'authorName', 'description', 'documentDate', 'tags'];
    console.log('DATABASE: detail query succeeded.');
    for (const key of fields) {
      const value = detail[key];
      console.log(`  ${key}: ${value == null || value === '' || (Array.isArray(value) && !value.length) ? 'empty in database' : 'has saved data'}`);
    }
    console.log('If the browser still fails, compare its Network response with LOCAL API and check proxy/PM2 deployment.');
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
}

main().catch(error => {
  console.error('ERROR:', error.code || error.name, error.message);
  process.exitCode = 1;
});
