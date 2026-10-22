// Exercise the real multipart parser locally using memory storage; no DB or archive.
require('reflect-metadata');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const multer = require('multer');
const { getMetadataArgsStorage } = require('typeorm');
const { Document } = require('../dist/entities/document.entity');
// Config constructs diskStorage on import, even though this test uses memory.
process.env.UPLOAD_STAGING_DIR = require('node:os').tmpdir();
const { multerOptions } = require('../dist/documents/multer.config');

async function main() {
  const app = express();
  const upload = multer({ ...multerOptions, storage: multer.memoryStorage() });
  app.post('/upload', upload.single('file'), (req, res) => res.json({
    description: req.body.description, filename: req.file?.originalname,
  }));
  app.post('/upload-multiple', upload.array('files', 20), (req, res) => res.json({
    description: req.body.description, count: req.files.length,
  }));
  app.use((error, req, res, next) => res.status(400).json({ code: error.code, field: error.field }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const description = 'Hướng dẫn chẩn đoán và điều trị tiểu đường.\r\n'.repeat(12000);
  assert(Buffer.byteLength(description) > 65536);
  assert(Buffer.byteLength(description) < multerOptions.limits.fieldSize);
  try {
    for (const route of ['upload', 'upload-multiple']) {
      const form = new FormData();
      form.append('description', description);
      form.append(route === 'upload' ? 'file' : 'files', new Blob(['%PDF-1.7\n'], { type: 'application/pdf' }), 'test.pdf');
      const response = await fetch(`${base}/${route}`, { method: 'POST', body: form, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.description, description, 'Vietnamese extracted text must arrive without truncation');
      if (route === 'upload') assert.equal(body.filename, 'test.pdf');
      else assert.equal(body.count, 1);
    }
    const oversized = new FormData();
    oversized.append('description', 'x'.repeat(multerOptions.limits.fieldSize + 1));
    const rejected = await fetch(`${base}/upload`, { method: 'POST', body: oversized, signal: AbortSignal.timeout(10000) });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { code: 'LIMIT_FIELD_VALUE', field: 'description' });
    const column = getMetadataArgsStorage().columns.find(item => item.target === Document && item.propertyName === 'description');
    assert.equal(column.options.type, 'mediumtext');
    console.log('PASS: single/batch uploads preserve Vietnamese text above 64 KiB; fields above 8 MiB remain rejected; description uses MEDIUMTEXT.');
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
