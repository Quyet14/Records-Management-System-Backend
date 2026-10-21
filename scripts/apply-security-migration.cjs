require('dotenv').config();
require('reflect-metadata');
const { DataSource } = require('typeorm');
const database = require('../dist/config/typeorm.config').default;
const { SecurityHardening1792540800000 } = require('../dist/migrations/1792540800000-SecurityHardening');
(async () => {
  if (!process.argv.includes('--apply')) throw Error('Run after build, backup and review: node scripts/apply-security-migration.cjs --apply');
  if (process.env.DB_SYNCHRONIZE === 'true') throw Error('Set DB_SYNCHRONIZE=false before applying migrations.');
  const db = new DataSource({ ...database(), synchronize: false, logging: false, migrationsRun: false,
    migrations: [SecurityHardening1792540800000] });
  await db.initialize();
  try { console.log('Applied:', (await db.runMigrations({ transaction: 'none' })).map(m => m.name)); }
  finally { await db.destroy(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
