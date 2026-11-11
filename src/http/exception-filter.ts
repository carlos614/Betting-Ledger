import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { errorBody, toErrorResponse } from './api';

interface ResponseLike {
  status(code: number): { json(body: unknown): unknown };
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'INVALID_PAYLOAD',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/**
 * Erros gerados pelo próprio framework (rota inexistente, JSON malformado, corpo grande demais, guard):
 * saem no MESMO envelope {error:{code,message,retryable}} dos demais endpoints.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ResponseLike>();
    const status = clientStatusOf(exception);
    if (status !== undefined) {
      res.status(status).json(errorBody(CODE_BY_STATUS[status] ?? 'CLIENT_ERROR', status === 400 ? 'malformed request' : messageOf(exception), false));
      return;
    }
    const mapped = toErrorResponse(exception, 'framework');
    res.status(mapped.status).json(mapped.body);
  }
}

function clientStatusOf(e: unknown): number | undefined {
  if (e instanceof HttpException) {
    const s = e.getStatus();
    return s >= 400 && s < 500 ? s : undefined;
  }
  const s = (e as { status?: unknown; statusCode?: unknown } | null)?.status ?? (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' && s >= 400 && s < 500 ? s : undefined; // erros do body-parser (JSON inválido etc.)
}

const messageOf = (e: unknown): string => (e instanceof HttpException ? e.message : String((e as Error)?.message ?? 'client error'));
