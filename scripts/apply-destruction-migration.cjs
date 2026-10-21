// Explicit operator action only. This script is never invoked during application startup.
require('dotenv').config();
require('reflect-metadata');
const { DataSource } = require('typeorm');
const database = require('../dist/config/typeorm.config').default;
const { DestructionWorkflow1792368000000 } = require('../dist/migrations/1792368000000-DestructionWorkflow');
async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Run npm run build, back up the DB, then invoke with --apply on staging first.');
  if (process.env.DB_SYNCHRONIZE === 'true') throw new Error('Set DB_SYNCHRONIZE=false before applying this migration.');
  const ds = new DataSource({ ...database(), synchronize: false, logging: false,
    migrations: [DestructionWorkflow1792368000000], migrationsTransactionMode: 'none' });
  await ds.initialize();
  try {
    console.log('Applied migrations:', (await ds.runMigrations({ transaction: 'none' })).map(m => m.name));
    if (process.argv.includes('--repair')) {
      const runner = ds.createQueryRunner();
      try {
        await runner.connect();
        await new DestructionWorkflow1792368000000().up(runner);
        console.log('Rechecked schema and added missing protections. Existing triggers were retained.');
      } finally { await runner.release(); }
    }
  }
  finally { await ds.destroy(); }
}
main().catch(error => {
  console.error(error.message);
  if (error.query) console.error('Failed SQL:', error.query);
  process.exitCode = 1;
});
