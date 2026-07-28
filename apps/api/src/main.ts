import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { envNumber } from './common/config/env-number.helper';

// @ts-ignore
BigInt.prototype.toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const trustProxyHops = envNumber('TRUST_PROXY_HOPS', 0);
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0 && trustProxyHops <= 5) {
    // Só habilite quando a API não estiver acessível diretamente: o valor indica
    // quantos proxies controlados existem entre cliente e Express.
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);
  }
  // Limite do corpo da requisição. O padrão do Express (100kb) é pequeno para o
  // logo de marca enviado em base64 (até ~550KB de string). 2mb cobre com folga.
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const forwardedRequestId = req.headers['x-request-id'];
    const requestId = typeof forwardedRequestId === 'string' && forwardedRequestId.trim()
      ? forwardedRequestId.trim().slice(0, 128)
      : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });
  app.use(
    helmet({
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );
  const corsAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (corsAllowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      // Do not turn browser preflight checks into API 500 responses.
      // Missing origins are denied by omitting CORS headers, while the real
      // fix remains adding the production origin to CORS_ALLOWED_ORIGINS.
      callback(null, false);
    },
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = envNumber('API_PORT', 3000);
  await app.listen(port);
}

void bootstrap();
