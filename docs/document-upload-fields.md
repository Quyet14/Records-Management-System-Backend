# Uploading extracted PDF descriptions

The document upload parser accepts up to 8 MiB of UTF-8 bytes per multipart
text field. The previous 64 KiB limit rejected descriptions extracted from
long PDFs with `Field value too long` before the upload service ran.
The file-size limit is configured separately by `MAX_FILE_SIZE_MB`.

`documents.description` uses MySQL `MEDIUMTEXT` so accepted descriptions can
be saved without truncation. Existing databases must be widened before
deploying the updated backend, especially when `DB_SYNCHRONIZE=false`:

```powershell
node scripts/expand-document-description.cjs
npm run db:expand-document-description
npm run build
```

Run these commands from the backend directory on the application server,
then restart the backend using its existing process manager. The first command
only inspects the schema and previews the change. The migration preserves
existing descriptions and collation, and does nothing if the column already
uses `MEDIUMTEXT` or `LONGTEXT`.

Regression check without a database or archive:

```powershell
npm run test:upload-fields
```

## Antivirus scan failures

Uploads use `UPLOAD_SCANNER` (`clamav` or `defender`). When unset, the backend
uses `DESTRUCTION_SCANNER`, then defaults to `clamav`. This lets Windows
deployments already configured for Defender use the same scanner for uploads.
An explicit `UPLOAD_SCANNER` takes priority.

For Microsoft Defender, set:

```dotenv
UPLOAD_SCAN_ENABLED=true
UPLOAD_SCANNER=defender
```

`UPLOAD_DEFENDER_PATH` optionally specifies the absolute path to `MpCmdRun.exe`;
otherwise `DESTRUCTION_DEFENDER_PATH` or automatic discovery is used. Defender
must be running with current signatures and accessible to the backend account.
For ClamAV, set `UPLOAD_SCANNER=clamav` and the absolute `UPLOAD_CLAMAV_PATH`,
and ensure its signature database is available to that account.

After building, check the scanner with the same account that runs the backend:

```powershell
node scripts/check-upload-scanner.cjs
```

This performs a real scan of a temporary harmless PDF and cleans up the probe.
Restart the backend after changing configuration; with PM2 use
`pm2 restart lths-backend --update-env`. Failed or inconclusive scans continue
to reject uploads. Backend logs record provider and process error codes without
scanner output or document contents.

Offline scanner regression checks:

```powershell
node scripts/test-upload-scanner.cjs
node scripts/test-destruction-defender.cjs
```
