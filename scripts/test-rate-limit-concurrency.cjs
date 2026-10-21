// Live MySQL/MariaDB verification. Creates/drops one uniquely named scratch table;
// does not read or modify real security counters, documents, users or audit rows.
require('dotenv').config();
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const database = require('../dist/config/typeorm.config').default;
const { DatabaseThrottleStorage } = require('../dist/security/security.module');

async function main() {
  const config = database();
  const db = new DataSource({ type: 'mysql', host: config.host, port: config.port, username: config.username,
    password: config.password, database: config.database, timezone: 'Z', logging: false,
    extra: { connectionLimit: 12 } });
  const table = `lths_rate_probe_${randomBytes(8).toString('hex')}`;
  let created = false;
  await db.initialize();
  try {
    await db.query(`CREATE TABLE \`${table}\` (bucket_key VARCHAR(64) PRIMARY KEY, hits INT NOT NULL DEFAULT 0,
      expires_ms BIGINT NOT NULL DEFAULT 0, blocked_ms BIGINT NOT NULL DEFAULT 0) ENGINE=InnoDB`);
    created = true;
    // Rewrite only the storage table identifier in our fixed limiter SQL.
    const isolated = { transaction: operation => db.transaction(manager => operation({
      query: (sql, params) => manager.query(sql.replace(/\bsecurity_rate_limits\b/g, `\`${table}\``), params),
    })) };
    const storages = [new DatabaseThrottleStorage(isolated), new DatabaseThrottleStorage(isolated)];
    for (let round = 0; round < 3; round++) {
      const key = createHash('sha256').update(`${table}:${round}`).digest('hex');
      const results = await Promise.allSettled(Array.from({ length: 120 }, (_, index) =>
        storages[index % storages.length].increment(key, 600000, 40, 600000, 'global')));
      assert.equal(results.filter(result => result.status === 'rejected').length, 0, 'No parallel call may fail with a deadlock/503');
      const records = results.map(result => result.value);
      assert.equal(records.filter(record => !record.isBlocked).length, 40);
      assert.equal(records.filter(record => record.isBlocked).length, 80);
      const [stored] = await db.query(`SELECT hits FROM \`${table}\` WHERE bucket_key=?`, [key]);
      assert.equal(Number(stored.hits), 41, 'The first blocked call is counted; subsequent blocked calls preserve the counter');
    }
    console.log('PASS: live InnoDB, two limiter instances, 3 rounds of 120 parallel requests; exact limits and no failed transactions.');
  } finally {
    try { if (created) await db.query(`DROP TABLE \`${table}\``); }
    finally { await db.destroy(); }
  }
}
main().catch(error => { console.error('Concurrency verification failed:', error.message); process.exitCode = 1; });
