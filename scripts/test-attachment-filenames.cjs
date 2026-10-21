require('reflect-metadata');
const assert = require('node:assert/strict');
const { normalizeUploadFilename, pdfContentDisposition } = require('../dist/common/upload-filename');

const names = [
  'Quyết định hủy (đã ký).pdf', 'Biên bản họp Hội đồng.pdf',
  'Café.pdf', '報告書.pdf', 'Hồ sơ 📄.pdf', 'Report + appendix [1].pdf',
];
for (const name of names) {
  assert.equal(normalizeUploadFilename(name), name);
  const header = pdfContentDisposition(name);
  assert.equal(decodeURIComponent(header.split("filename*=UTF-8''")[1]), name);
  assert(!/[\r\n]/.test(header));
  assert(/^[\x20-\x7e]+$/.test(header));
}
const vietnamese = 'Quyết định hủy (đã ký).pdf';
assert.equal(normalizeUploadFilename(Buffer.from(vietnamese, 'utf8').toString('latin1')), vietnamese);
assert.equal(normalizeUploadFilename(`C:\\fakepath\\${vietnamese}`), vietnamese);
assert.equal(normalizeUploadFilename(`../${vietnamese}`), vietnamese);
assert.equal(normalizeUploadFilename('Cafe\u0301.pdf'), 'Café.pdf');
assert.equal(normalizeUploadFilename('a"\r\nb.pdf'), 'a___b.pdf');
assert(!pdfContentDisposition('a"\r\nb.pdf').includes('\r\n'));
assert.throws(() => normalizeUploadFilename(''), error => error.getStatus() === 422);
assert.throws(() => normalizeUploadFilename('../'), error => error.getStatus() === 422);
assert.equal(Array.from(normalizeUploadFilename('📄'.repeat(300) + '.pdf')).length, 240);
console.log('PASS: UTF-8/Latin-1 multipart names, Vietnamese/Unicode, paths, punctuation, header injection and original download names.');
