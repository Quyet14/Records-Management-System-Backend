export function uploadLimitBytes(): number {
  const megabytes = Number(process.env.MAX_FILE_SIZE_MB || '51200');
  const bytes = megabytes * 1024 * 1024;
  if (!Number.isSafeInteger(megabytes) || megabytes <= 0 || !Number.isSafeInteger(bytes))
    throw new Error('MAX_FILE_SIZE_MB must be a positive integer within the safe byte range');
  return bytes;
}
