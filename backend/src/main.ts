import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { AllExceptionsFilter, AuthGuard } from './common/http';
import { rateLimit, securityHeaders } from './common/rate-limit';
import { config } from './config';
import { Db } from './db';
import { AuthController } from './modules/auth.controller';
import { BookingsController } from './modules/bookings.controller';
import { BookingsService } from './modules/bookings.service';
import { DocumentsService } from './modules/documents.service';
import { FinanceController, RecapService } from './modules/finance.controller';
import { GoogleService } from './modules/google.service';
import { HealthController, IntegrationsController } from './modules/integrations.controller';
import { MastersController } from './modules/masters.controller';

@Module({
  controllers: [AuthController, MastersController, BookingsController, FinanceController, IntegrationsController, HealthController],
  providers: [
    Db, BookingsService, DocumentsService, RecapService, GoogleService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class AppModule {}

async function bootstrap() {
  // schema, seed and DB roles are applied by the one-shot migrate job (dist/migrate.js) with owner credentials
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(pinoHttp({
    autoLogging: { ignore: (req) => /\/(health|ready)$/.test(req.url ?? '') },
    // SEC-G10: the refresh token travels in Set-Cookie, so response headers are redacted too
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[redacted]' },
  }));
  app.use(securityHeaders);
  app.use(rateLimit);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '200kb' });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  console.log(`api listening on :${config.port}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
