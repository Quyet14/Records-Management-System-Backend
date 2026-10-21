import * as dotenv from 'dotenv';
import { uploadLimitBytes } from './upload-policy';

dotenv.config();

// MAX_FILE_SIZE_MB uses binary megabytes: 51200 MiB = 50 GiB.
export const MAX_UPLOAD_FILE_SIZE_BYTES = uploadLimitBytes();
