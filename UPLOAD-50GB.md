# Upload files up to 50 GB

The application uses binary units: 50 GiB = 51,200 MiB = 53,687,091,200 bytes per file.

## Deploy on the machine running the API

1. Update the backend source, then run npm run build.
2. Set MAX_FILE_SIZE_MB=51200 in the runtime environment. The updated PM2 ecosystem file also sets these production values.
3. For this repository's PM2 setup, run pm2 startOrReload ecosystem.config.js --env production --update-env.
4. Deploy the updated frontend pages/upload.html and assets/js/app.js.
5. If a reverse proxy fronts the API, update its body limit and upload timeouts too. The Nginx location snippet is in deploy/nginx-upload.conf.example; it is an example, not an automatically installed configuration. Validate the full configuration with nginx -t before reloading Nginx.

## Behavior

- Uploads stream to staging disk; SHA-256 hashing already uses a read stream. File sizes are stored as bigint.
- The browser sends File objects through FormData and shows actual network upload progress. It skips automatic PDF text extraction above 50 MiB so it does not read multi-gigabyte files into JavaScript memory. Manual descriptions remain available.
- The Node request body deadline is disabled for streaming uploads; reverse proxy receive/send timeouts in the example are 24 hours. The upload is a single multipart request and does not resume after a connection interruption.
- Staging and archive volumes need enough free space for the selected files. Multiple files are uploaded sequentially by the frontend.
- Boundary and configuration checks do not substitute for a real large-file upload through the production network; run that check after deployment.
