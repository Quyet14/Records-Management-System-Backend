// Regression checks use the real service and SQL scopes with an in-memory database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true }
  });
  module._compile(output.outputText, filename);
};
const { DocumentsService } = require('../src/documents/documents.service.ts');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE docs (id TEXT, uploader_id TEXT, department_id TEXT, visibility TEXT, status TEXT, securityLevel TEXT, destructionStartedAt TEXT, createdAt TEXT);
  CREATE TABLE users (id TEXT); CREATE TABLE departments (id TEXT);
  INSERT INTO users VALUES ('me'), ('other'); INSERT INTO departments VALUES ('a'), ('b');`);
const insert = db.prepare('INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, NULL, ?)');
for (const visibility of ['public', 'department', 'private']) {
  for (const status of ['pending', 'stored', 'rejected']) {
    insert.run(`own-${visibility}-${status}`, 'me', 'b', visibility, status, 'secret', '2026-10-27');
    insert.run(`other-${visibility}-${status}`, 'other', 'b', visibility, status, 'normal', '2026-10-27');
  }
}
function repository() {
  const clauses = [], params = {};
  const qb = {
    leftJoinAndSelect() { return this; }, select() { return this; }, addSelect() { return this; },
    andWhere(sql, values = {}) { clauses.push(sql); Object.assign(params, values); return this; },
    orderBy() { return this; }, skip() { return this; }, take() { return this; },
    async getManyAndCount() {
      const values = [];
      const where = clauses.join(' AND ').replace(/AS BINARY/g, 'AS TEXT').replace(/:(\.\.\.)?(\w+)/g, (_, spread, key) => {
        assert.ok(Object.hasOwn(params, key), key);
        const entries = spread ? params[key] : [params[key]];
        values.push(...entries); return entries.map(() => '?').join(',');
      });
      const rows = db.prepare(`SELECT doc.id FROM docs doc LEFT JOIN users uploader ON uploader.id = doc.uploader_id
        LEFT JOIN departments department ON department.id = doc.department_id WHERE ${where}`).all(...values);
      return [rows, rows.length];
    }
  };
  return { createQueryBuilder: () => qb };
}
const service = Object.create(DocumentsService.prototype);
async function search(query, actor) {
  service.docsRepo = repository();
  return service.search(query, actor);
}
(async () => {
  for (const departmentId of ['a', undefined]) {
    const actor = { id: 'me', role: 'user', departmentId };
    const general = await search({}, actor);
    assert.equal(general.data.filter(row => row.id.startsWith('own-')).length, 9, 'all own uploads remain visible across status, visibility and department');
    assert.deepEqual(general.data.filter(row => row.id.startsWith('other-')).map(row => row.id), ['other-public-stored']);
    for (const uploaderId of ['me', 'other']) {
      const personal = await search({ uploaderId }, actor);
      assert.equal(personal.total, 9);
      assert.ok(personal.data.every(row => row.id.startsWith('own-')), 'ordinary user cannot select another uploader');
    }
    const pending = await search({ uploaderId: 'me', status: 'pending' }, actor);
    assert.equal(pending.total, 3);
  }
  const staff = await search({ uploaderId: 'other' }, { id: 'me', role: 'admin' });
  assert.equal(staff.total, 9);
  assert.ok(staff.data.every(row => row.id.startsWith('other-')));
  db.close();
  console.log('Personal search regression checks passed.');
})().catch(error => { console.error(error); db.close(); process.exitCode = 1; });
