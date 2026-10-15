import * as fs from 'fs';
import * as path from 'path';

const crashLogPath = path.join(__dirname, '..', 'logs', 'crash-debug.log');
fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });

function logCrash(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(crashLogPath, line);
}

process.on('exit', (code) => logCrash(`PROCESS EXIT - code: ${code}, memoryUsage: ${JSON.stringify(process.memoryUsage())}`));
process.on('SIGTERM', () => logCrash('Received SIGTERM'));
process.on('SIGINT', () => logCrash('Received SIGINT'));
process.on('uncaughtException', (err) => {
  logCrash(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason: any) => {
  logCrash(`UNHANDLED REJECTION: ${reason?.stack || reason}`);
});

// Log memory mỗi 5 giây để theo dõi trend
setInterval(() => {
  const mem = process.memoryUsage();
  logCrash(`MEM CHECK - rss: ${(mem.rss / 1024 / 1024).toFixed(1)}MB, heapUsed: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB, heapTotal: ${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB`);
}, 5000);

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { Server } from 'http';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // loại bỏ field lạ không khai báo trong DTO
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors(); // siết lại origin cụ thể khi lên production

  // Large multipart uploads can exceed Node's default request deadline.
  // Keep header/idle protections; allow the upload body to finish streaming.
  (app.getHttpServer() as Server).requestTimeout = 0;

  const port = process.env.PORT || 3002;
  await app.listen(port, '0.0.0.0');
  console.log(`Backend đang chạy tại http://localhost:${port}`);
}
bootstrap();
