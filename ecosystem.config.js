module.exports = {
  apps: [
    {
      name: 'lths-backend',
      script: './dist/main.js',
      instances: 'max',
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      min_uptime: '10s',
      max_restarts: 10,
      kill_timeout: 5000,
      env_production: {
        NODE_ENV: 'production',
        PORT: 3002,
        MAX_FILE_SIZE_MB: 51200,
        AUTH_COOKIE_SECURE: 'true',
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3002,
        AUTH_COOKIE_SECURE: 'false',
        AUTH_COOKIE_SAME_SITE: 'lax',
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
