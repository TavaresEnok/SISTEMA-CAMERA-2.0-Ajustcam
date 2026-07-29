import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { envNumber } from './common/config/env-number.helper';
import { RedactingLogger } from './common/logging/redacting-logger';
import { redactSensitiveText } from './common/security/sensitive-text.helper';

// @ts-ignore
BigInt.prototype.toJSON = function () {
  return this.toString();
};

// ─────────────────────────────────────────────────────────────────────────────
// REDE DE SEGURANÇA PARA ROTINA DE FUNDO.
//
// Várias rotinas periódicas são disparadas com `void this.X()` dentro de
// setInterval/setTimeout (guarda de disco, retenção, recuperação de órfãos,
// varredura de integridade, heartbeat da Central). Sob esse padrão, uma promessa
// rejeitada não tem quem a capture: em Node ≥15 o default é
// `--unhandled-rejections=throw`, e o processo MORRE.
//
// Num VMS isso não é "só" indisponibilidade. A API caindo mata todo ffmpeg de
// gravação; o container volta (restart: unless-stopped), mas
// RECORDING_AUTO_START_ENABLED é `false` por padrão — a gravação CONTÍNUA NÃO
// volta sozinha. Um Postgres reiniciando no instante errado viraria acervo
// perdido, em silêncio.
//
// A escolha aqui é deliberada: seguir vivo e reclamar ALTO. É o oposto de
// engolir o erro — ele vai para o log como ERROR, com stack, e o processo
// continua gravando. Rotinas individuais devem ter o seu próprio try/catch
// (esta é a última linha de defesa, não a primeira).
//
// `uncaughtException` NÃO é tratado de propósito: ali o estado do processo é
// realmente indefinido, e insistir seria pior do que deixar o container
// reiniciar limpo.
// ─────────────────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  // A rotina de fundo que mais rejeita sem catch é justamente a de mídia, e a
  // mensagem do FFmpeg carrega a URL RTSP INTEIRA — com usuário e senha. Este
  // handler escreve direto no console (não passa pelo logger do Nest), então a
  // redação precisa ser explícita aqui: sem ela, esta rede de segurança viraria
  // o maior vazador de credencial do processo.
  // eslint-disable-next-line no-console
  console.error(`[unhandledRejection] rotina de fundo falhou sem catch — a API SEGUE viva: ${redactSensitiveText(detail)}`);
});

async function bootstrap() {
  // O logger é trocado ANTES de qualquer outra coisa subir: a partir daqui todo
  // `Logger.log/error/...` da aplicação passa pela redação de credencial, sem
  // depender de o autor de cada ponto de chamada lembrar de sanitizar.
  const app = await NestFactory.create(AppModule, { logger: new RedactingLogger() });
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
