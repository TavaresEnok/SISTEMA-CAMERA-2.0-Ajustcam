import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { redactSensitiveText } from '../security/sensitive-text.helper';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : { message: 'Internal server error' };
    const safePath = redactSensitiveText(request.url);

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: safePath,
      method: request.method,
      requestId: typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : undefined,
      ...(typeof message === 'object' ? message : { message }),
    };

    // Log the error
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${safePath} ${status} requestId=${errorResponse.requestId ?? '-'}`,
        exception instanceof Error ? exception.stack : JSON.stringify(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${safePath} ${status} requestId=${errorResponse.requestId ?? '-'}`);
    }

    response.status(status).json(errorResponse);
  }
}
