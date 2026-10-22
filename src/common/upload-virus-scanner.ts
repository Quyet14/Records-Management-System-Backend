import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { WindowsDefenderScanner } from '../destruction/windows-defender-scanner';

const execute = promisify(execFile);
const logger = new Logger('UploadVirusScanner');

export async function scanUploadForViruses(filename: string): Promise<void> {
  const provider = process.env.UPLOAD_SCANNER || process.env.DESTRUCTION_SCANNER || 'clamav';
  if (!['clamav', 'defender'].includes(provider)) {
    throw new ServiceUnavailableException('UPLOAD_SCANNER phải là clamav hoặc defender.');
  }
  if (provider === 'clamav') {
    const scanner = process.env.UPLOAD_CLAMAV_PATH;
    if (!scanner || !path.isAbsolute(scanner)) {
      throw new ServiceUnavailableException('Chưa cấu hình đường dẫn tuyệt đối UPLOAD_CLAMAV_PATH.');
    }
  }
  try {
    if (provider === 'defender') {
      const config = new ConfigService({
        DESTRUCTION_DEFENDER_PATH: process.env.UPLOAD_DEFENDER_PATH || process.env.DESTRUCTION_DEFENDER_PATH,
      });
      await new WindowsDefenderScanner(config).scan(path.resolve(filename));
    } else {
      await execute(process.env.UPLOAD_CLAMAV_PATH!,
        ['--no-summary', '--infected', '--alert-exceeds-max=yes', '--alert-encrypted=yes', '--alert-broken=yes', '--', path.resolve(filename)],
        { timeout: 120000, maxBuffer: 64 * 1024, windowsHide: true });
    }
  } catch (error) {
    // Do not log scanner output, which can include document filenames/content.
    logger.error(`provider=${provider} code=${error.code ?? 'unknown'} signal=${error.signal ?? 'none'} killed=${error.killed === true}`);
    if (provider === 'clamav' && error.code === 1) {
      throw new BadRequestException('File bị từ chối vì phát hiện mã độc hoặc không đạt chính sách quét an toàn.');
    }
    if (error.code === 'ENOENT') {
      throw new ServiceUnavailableException('Không tìm thấy trình quét virus. Kiểm tra đường dẫn và cài đặt trên server.');
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw new ServiceUnavailableException('Tài khoản chạy backend không có quyền chạy trình quét virus hoặc đọc file.');
    }
    if (error.killed) {
      throw new ServiceUnavailableException('Quét virus quá thời gian cho phép. File chưa được chấp nhận.');
    }
    throw new ServiceUnavailableException(provider === 'defender'
      ? 'Microsoft Defender chưa xác nhận file an toàn. Kiểm tra trạng thái antivirus, dữ liệu nhận diện virus và quyền của tài khoản backend.'
      : 'ClamAV không hoàn tất quét virus. Kiểm tra dữ liệu nhận diện virus, cấu hình và log backend.');
  }
}
