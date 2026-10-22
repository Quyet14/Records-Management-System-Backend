// Operator repair. Default is a plan; --apply copies/updates only the retained record.
require('dotenv').config();
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const database = require('../dist/config/typeorm.config').default;
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
const { DestructionInfrastructure } = require('../dist/destruction/destruction.infrastructure');
const { separateRetainedContent } = require('../dist/destruction/separate-retained-content');
async function main() {
  const args = process.argv.slice(2), flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (flags.has(key) || !['--destroy', '--keep', '--actor', '--reason', '--apply', '--list-admins'].includes(key))
      throw Error('Tham so khong hop le. Chay tung lenh tren mot dong rieng; khong ghep --apply voi lenh node tiep theo.');
    flags.set(key, ['--apply', '--list-admins'].includes(key) ? true : args[++i]);
  }
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const options = { destroyId: flags.get('--destroy'), keepId: flags.get('--keep'), actorId: flags.get('--actor'),
    reason: flags.get('--reason'), apply: flags.has('--apply') };
  const listAdmins = flags.has('--list-admins');
  if (listAdmins && flags.size !== 1) throw Error('Use --list-admins alone.');
  if (!listAdmins && (!uuid(options.destroyId) || !uuid(options.keepId) || (options.actorId && !uuid(options.actorId))
    || (options.apply && (!uuid(options.actorId) || !options.reason?.trim() || options.reason.length > 4000)))
    ) throw Error('Use --list-admins to find an actual admin UUID; ADMIN_UUID is a placeholder. Usage: --destroy <uuid> --keep <uuid> [--actor <actual-admin-uuid> --reason "reason" --apply]');
  const config = new ConfigService(process.env);
  if (new DestructionInfrastructure(config).provider() !== 'local') throw Error('This command supports only the local storage provider.');
  const ds = new DataSource({ ...database(), synchronize: false, migrationsRun: false, logging: false });
  await ds.initialize();
  const local = new LocalDestructionInfrastructure(config, ds);
  try {
    if (listAdmins) {
      console.table(await ds.manager.query("SELECT id,full_name FROM users WHERE role='admin' AND is_active=1 ORDER BY id"));
      return;
    }
    const result = await separateRetainedContent(ds, local, options);
    console.log(JSON.stringify(result, null, 2));
    if (!options.apply) {
      console.log('PLAN ONLY: no content or metadata changed. Active admin IDs for --actor:');
      console.table(await ds.manager.query("SELECT id,full_name FROM users WHERE role='admin' AND is_active=1 ORDER BY id"));
    } else {
      console.log('Retained content verified. Original file and destruction request/checkpoints unchanged.');
      console.log('Verify both records, back up the retained copy with the existing backup workflow, then use retry-destruction.cjs for the failed request.');
    }
  } finally { local.onModuleDestroy(); await ds.destroy(); }
}
main().catch(error => {
  const response = error?.getResponse?.();
  console.error(response?.code ? `${response.code}: ${response.message}`
    : error?.name === 'QueryFailedError' ? 'Database operation failed; no originals were deleted. Check the database and run the plan again.' : error.message);
  process.exitCode = 1;
});
