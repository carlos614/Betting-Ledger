import type { LoggerService } from '@nestjs/common';
import { logEvent } from '../../application/log';

/** Logger do Nest em JSON estruturado (uma linha por evento). */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    logEvent('info', String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string): void {
    logEvent('error', String(message), { context, trace });
  }
  warn(message: unknown, context?: string): void {
    logEvent('warn', String(message), { context });
  }
  debug(message: unknown, context?: string): void {
    logEvent('debug', String(message), { context });
  }
  verbose(message: unknown, context?: string): void {
    logEvent('debug', String(message), { context });
  }
}
