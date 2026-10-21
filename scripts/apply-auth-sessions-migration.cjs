require('dotenv').config();
require('reflect-metadata');
const { DataSource } = require('typeorm');
const database = require('../dist/config/typeorm.config').default;
const { AuthDeviceSessions1792454400000 } = require('../dist/migrations/1792454400000-AuthDeviceSessions');
(async () => {
  if (!process.argv.includes('--apply')) throw Error('Back up the test database and run with --apply after npm run build.');
  if (process.env.DB_SYNCHRONIZE === 'true') throw Error('Set DB_SYNCHRONIZE=false first.');
  const ds = new DataSource({ ...database(), synchronize: false, logging: false, migrationsRun: false,
    migrations: [AuthDeviceSessions1792454400000] });
  await ds.initialize();
  try { console.log('Applied:', (await ds.runMigrations({ transaction: 'none' })).map(m => m.name)); }
  finally { await ds.destroy(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
