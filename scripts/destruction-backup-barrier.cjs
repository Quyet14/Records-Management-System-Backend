require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const { DestructionInfrastructure } = require('../dist/destruction/destruction.infrastructure');
const { beginBarrier, endBarrier } = require('../dist/destruction/backup-barrier');
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const database = require('../dist/config/typeorm.config').default;
async function begin(archiveDir, operation = 'backup', mysqlConfig) {
  const config = new ConfigService(process.env);
  const options = { ...database(), synchronize: false, logging: false };
  if (mysqlConfig) Object.assign(options, { host: mysqlConfig.host, port: mysqlConfig.port, username: mysqlConfig.user,
    password: mysqlConfig.password, database: mysqlConfig.database });
  const ds = new DataSource(options);
  await ds.initialize();
  const local = new LocalDestructionInfrastructure(config, ds);
  const gateway = new DestructionInfrastructure(config, local);
  try {
    const barrier = await beginBarrier(ds.manager, gateway, archiveDir, operation);
    return { ...barrier, finish: async success => {
      try { await endBarrier(gateway, barrier, success); }
      finally { local.onModuleDestroy(); await ds.destroy(); }
    } };
  } catch (error) { local.onModuleDestroy(); await ds.destroy(); throw error; }
}
module.exports = { begin };
