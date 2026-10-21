import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execute = promisify(execFile);
// Fixed script only: no filenames, upload data or configuration are interpolated into PowerShell.
const STATUS_SCRIPT = "$ErrorActionPreference='Stop'; $s=Get-MpComputerStatus; "
  + '[pscustomobject]@{AMServiceEnabled=$s.AMServiceEnabled; AntivirusEnabled=$s.AntivirusEnabled; '
  + 'DefenderSignaturesOutOfDate=$s.DefenderSignaturesOutOfDate; '
  + 'AntivirusSignatureVersion=$s.AntivirusSignatureVersion} | ConvertTo-Json -Compress';

/** Scan only; never changes Defender settings, exclusions or remediation policy. */
export class WindowsDefenderScanner {
  constructor(private readonly config: ConfigService) {}

  private async run(executable: string, args: string[]) {
    return execute(executable, args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  }

  executable(): string {
    if (process.platform !== 'win32') throw new Error('Microsoft Defender chỉ được hỗ trợ trên Windows.');
    const configured = this.config.get<string>('DESTRUCTION_DEFENDER_PATH');
    if (configured) {
      if (!path.isAbsolute(configured) || !fs.statSync(configured).isFile()) throw new Error('DESTRUCTION_DEFENDER_PATH phải trỏ tới MpCmdRun.exe hiện có bằng đường dẫn tuyệt đối.');
      return configured;
    }
    const platform = path.join(process.env.ProgramData || 'C:/ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
    if (fs.existsSync(platform)) {
      const versions = fs.readdirSync(platform, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d+[\d.]*-\d+$/.test(e.name))
        .map(e => e.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      for (const version of versions) {
        const candidate = path.join(platform, version, 'MpCmdRun.exe');
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    }
    const fallback = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Windows Defender', 'MpCmdRun.exe');
    if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) return fallback;
    throw new Error('Không tìm thấy MpCmdRun.exe. Kiểm tra cài đặt Defender hoặc DESTRUCTION_DEFENDER_PATH.');
  }

  async ready(): Promise<void> {
    this.executable();
    const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await this.run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(STATUS_SCRIPT, 'utf16le').toString('base64')]);
    const status = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
    if (status.AMServiceEnabled !== true || status.AntivirusEnabled !== true
      || status.DefenderSignaturesOutOfDate !== false || !status.AntivirusSignatureVersion)
      throw new Error('Defender chưa bật hoặc dữ liệu nhận diện virus chưa sẵn sàng/cần cập nhật.');
  }

  async scan(filename: string): Promise<void> {
    await this.ready();
    if (!path.isAbsolute(filename) || !fs.statSync(filename).isFile()) throw new Error('Không truy cập được file cần quét.');
    // With DisableRemediation, exit 0 means no malware found. A detection/error (including exit 2),
    // timeout, missing file or access denial rejects the upload. Do not parse localized output.
    await this.run(this.executable(), ['-Scan', '-ScanType', '3', '-File', filename, '-DisableRemediation']);
    if (!fs.statSync(filename).isFile()) throw new Error('File không còn tồn tại sau khi quét.');
  }
}
