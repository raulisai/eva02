import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.useWebSocketAdapter(new IoAdapter(app));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Never default to '*': fall back to the local dashboard origin.
  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin && process.env.NODE_ENV === 'production') {
    logger.warn('CORS_ORIGIN is not set in production — defaulting to http://localhost:3001');
  }
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : 'http://localhost:3001',
    credentials: true,
  });

  if (!process.env.EVA_SECRETS_KEY) {
    logger.warn('EVA_SECRETS_KEY is not set — saving integration secrets will fail until configured');
  }

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port);
  console.log(`EVA Core running on port ${port}`);
}

bootstrap();
