import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { AllExceptionsFilter, AuthGuard } from './common/http';
import { config } from './config';
import { Db, migrate } from './db';
import { seed } from './seed';
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
  await migrate();
  await seed();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(pinoHttp({ autoLogging: { ignore: (req) => req.url?.endsWith('/health') ?? false }, redact: ['req.headers.authorization', 'req.headers.cookie'] }));
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
