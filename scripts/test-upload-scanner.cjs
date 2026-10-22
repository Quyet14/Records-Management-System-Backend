// Mock process transport; never invokes a real antivirus or changes its settings.
require('reflect-metadata');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
let failure = null;
const calls = [];
childProcess.execFile = (executable, args, options, callback) => {
  calls.push({ executable, args, options });
  process.nextTick(() => callback(failure, '', ''));
};
const { WindowsDefenderScanner } = require('../dist/destruction/windows-defender-scanner');
let defenderCalls = 0;
WindowsDefenderScanner.prototype.scan = async function(filename) {
  defenderCalls++;
  assert(path.isAbsolute(filename));
  assert.equal(this.config.get('DESTRUCTION_DEFENDER_PATH'), process.env.UPLOAD_DEFENDER_PATH);
  if (failure) throw failure;
};
const { scanUploadForViruses } = require('../dist/common/upload-virus-scanner');

async function main() {
  const filename = path.resolve('harmless fixture.pdf');
  delete process.env.UPLOAD_SCANNER;
  delete process.env.DESTRUCTION_SCANNER;
  delete process.env.UPLOAD_CLAMAV_PATH;
  await assert.rejects(() => scanUploadForViruses(filename), error => error.getStatus() === 503);
  process.env.UPLOAD_CLAMAV_PATH = path.resolve('clamscan.exe');
  await scanUploadForViruses(filename);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), filename);
  assert(calls[0].args.includes('--alert-exceeds-max=yes'));
  assert.equal(calls[0].options.windowsHide, true);
  for (const [code, status] of [[1, 400], [2, 503], ['ENOENT', 503], ['EACCES', 503]]) {
    failure = Object.assign(new Error('test failure'), { code });
    await assert.rejects(() => scanUploadForViruses(filename), error => error.getStatus() === status);
  }
  failure = Object.assign(new Error('timeout'), { killed: true });
  await assert.rejects(() => scanUploadForViruses(filename), error => /quá thời gian/.test(error.message));
  failure = null;
  process.env.DESTRUCTION_SCANNER = 'defender';
  process.env.UPLOAD_DEFENDER_PATH = path.resolve('MpCmdRun.exe');
  await scanUploadForViruses(filename);
  assert.equal(defenderCalls, 1, 'Uploads inherit the configured Defender provider');
  process.env.UPLOAD_SCANNER = 'clamav';
  await scanUploadForViruses(filename);
  assert.equal(defenderCalls, 1, 'An explicit upload provider overrides the destruction provider');
  process.env.UPLOAD_SCANNER = 'defender';
  for (const code of [1, 2, 'EACCES']) {
    failure = Object.assign(new Error('scan inconclusive'), { code });
    await assert.rejects(() => scanUploadForViruses(filename), error => error.getStatus() === 503);
  }
  process.env.UPLOAD_SCANNER = 'invalid';
  await assert.rejects(() => scanUploadForViruses(filename), error => error.getStatus() === 503);
  console.log('PASS: provider selection, Defender dispatch, ClamAV policy flags, detections, missing executable, permissions, timeouts and unknown providers.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
