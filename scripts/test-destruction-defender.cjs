// Process transport is mocked: never launches Defender, changes antivirus policy or scans real content.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ConfigService } = require('@nestjs/config');
const { WindowsDefenderScanner } = require('../dist/destruction/windows-defender-scanner');
const { LocalDestructionInfrastructure } = require('../dist/destruction/local-infrastructure');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lths-defender-test-'));
  const originalEnvironment = { ProgramData: process.env.ProgramData, ProgramFiles: process.env.ProgramFiles };
  let rejections = 0;
  try {
    const executable = path.join(root, 'MpCmdRun.exe'); fs.writeFileSync(executable, 'MOCK ONLY');
    const config = new ConfigService({ DESTRUCTION_SCANNER: 'defender', DESTRUCTION_DEFENDER_PATH: executable });
    if (process.platform === 'win32') {
      assert.equal(new WindowsDefenderScanner(config).executable(), executable);
      config.set('DESTRUCTION_DEFENDER_PATH', 'relative.exe');
      assert.throws(() => new WindowsDefenderScanner(config).executable()); rejections++;
      config.set('DESTRUCTION_DEFENDER_PATH', '');
      process.env.ProgramData = path.join(root, 'program-data'); process.env.ProgramFiles = path.join(root, 'program-files');
      for (const version of ['4.18.9.1-0', '4.18.10.1-0']) {
        const directory = path.join(process.env.ProgramData, 'Microsoft', 'Windows Defender', 'Platform', version);
        fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'MpCmdRun.exe'), 'MOCK ONLY');
      }
      assert(new WindowsDefenderScanner(config).executable().includes('4.18.10.1-0'));
      config.set('DESTRUCTION_DEFENDER_PATH', executable);
    } else {
      assert.throws(() => new WindowsDefenderScanner(config).executable()); rejections++;
    }
    const scanner = new WindowsDefenderScanner(config);
    scanner.executable = () => executable;
    const good = { AMServiceEnabled: true, AntivirusEnabled: true, DefenderSignaturesOutOfDate: false, AntivirusSignatureVersion: 'test-version' };
    let status = good, failure = null, afterScan = null;
    const invocations = [];
    scanner.run = async (file, args) => {
      invocations.push({ file, args });
      if (args.includes('-EncodedCommand')) {
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        assert(script.includes('Get-MpComputerStatus')); assert(!script.includes(root));
        return { stdout: typeof status === 'string' ? status : JSON.stringify(status) };
      }
      assert.equal(file, executable);
      assert.deepEqual(args.slice(0, 4), ['-Scan', '-ScanType', '3', '-File']);
      assert.equal(args.at(-1), '-DisableRemediation');
      if (failure) throw failure;
      if (afterScan) afterScan(args[4]);
      return { stdout: 'localized output is intentionally not parsed' };
    };
    await scanner.ready();
    for (const patch of [{ AMServiceEnabled: false }, { AntivirusEnabled: false }, { DefenderSignaturesOutOfDate: true },
      { DefenderSignaturesOutOfDate: null }, { AntivirusSignatureVersion: '' }, { AntivirusEnabled: 'True' }]) {
      status = { ...good, ...patch }; await assert.rejects(() => scanner.ready()); rejections++;
    }
    status = 'not JSON'; await assert.rejects(() => scanner.ready()); rejections++; status = good;
    const filename = path.join(root, 'file with spaces.pdf'); fs.writeFileSync(filename, 'harmless fixture');
    await scanner.scan(filename);
    assert(invocations.some(i => i.args.includes(filename)));
    for (const error of [Object.assign(Error('detection or scan error'), { code: 2 }), Object.assign(Error('access denied'), { code: 'EACCES' }),
      Object.assign(Error('timeout'), { killed: true }), Object.assign(Error('unknown exit'), { code: 99 })]) {
      failure = error; await assert.rejects(() => scanner.scan(filename)); rejections++;
    }
    failure = null;
    // End-to-end provider dispatch, identical scanned bytes, failure rejection and temporary-file cleanup.
    const local = new LocalDestructionInfrastructure(config, {});
    local.settings = () => ({ state: root }); local.maintenance = () => false;
    local.defender = () => scanner;
    local.command = () => { throw Error('ClamAV must not be invoked in Defender mode'); };
    const payload = { bytes: Buffer.from('harmless PDF readiness fixture').toString('base64') };
    assert.deepEqual(await local.call('scan-pdf', payload), { clean: true, readable: true });
    failure = Object.assign(Error('detection'), { code: 2 });
    assert.deepEqual(await local.call('scan-pdf', payload), { clean: false, readable: false }); rejections++;
    failure = null; afterScan = file => fs.writeFileSync(file, 'modified content');
    assert.deepEqual(await local.call('scan-pdf', payload), { clean: false, readable: false }); rejections++;
    afterScan = file => fs.unlinkSync(file);
    assert.deepEqual(await local.call('scan-pdf', payload), { clean: false, readable: false }); rejections++;
    afterScan = null; config.set('DESTRUCTION_SCANNER', 'invalid');
    assert.deepEqual(await local.call('scan-pdf', payload), { clean: false, readable: false }); rejections++;
    assert(!fs.readdirSync(root).some(name => name.startsWith('scan-')));
    console.log(`PASS: Defender discovery, status, custom scan arguments, detections/errors/timeouts, byte integrity and cleanup (${rejections} rejection cases).`);
    console.log('LIMIT: process transport mocked; verify actual Defender and PM2 account permissions on the deployment server.');
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const resolved = fs.realpathSync(root), temp = fs.realpathSync(os.tmpdir());
    const relative = path.relative(temp, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith('lths-defender-test-')) throw Error('Unsafe test cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
