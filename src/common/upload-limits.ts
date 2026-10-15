import * as dotenv from 'dotenv';

dotenv.config();

// MAX_FILE_SIZE_MB uses binary megabytes: 51200 MiB = 50 GiB.
const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB || '51200');
const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;
if (!Number.isSafeInteger(maxFileSizeMb) || maxFileSizeMb <= 0 || !Number.isSafeInteger(maxFileSizeBytes)) {
  throw new Error('MAX_FILE_SIZE_MB must be a positive integer within the safe byte range');
}

export const MAX_UPLOAD_FILE_SIZE_BYTES = maxFileSizeBytes;
