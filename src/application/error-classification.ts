import { IdempotencyConflictError, InvalidPayloadError } from '../domain/errors';

/** SQLSTATE de um erro do PostgreSQL (`pg` expõe em `code`; Bun.sql em `errno`). */
export function sqlState(err: unknown): string | undefined {
  const e = err as { code?: unknown; errno?: unknown } | null;
  for (const c of [e?.code, e?.errno]) {
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) return c;
  }
  return undefined;
}

/** deadlock, lock timeout, falha de serialização */
export function isLockConflict(err: unknown): boolean {
  const s = sqlState(err);
  return s === '40P01' || s === '55P03' || s === '40001';
}

/** Infraestrutura temporariamente indisponível ou conflito de lock: vale tentar de novo. */
export function isTransientInfrastructureError(err: unknown): boolean {
  if (isLockConflict(err)) return true;
  const s = sqlState(err);
  if (s && (s.startsWith('08') || s.startsWith('53') || s.startsWith('57') || s === '25P03')) return true;
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const msg = typeof e?.message === 'string' ? e.message : '';
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|CONNECTION_CLOSED|CONNECTION_TIMEOUT|ERR_POSTGRES_CONNECTION|Connection terminated|connection closed|timeout/i.test(`${code} ${msg}`);
}

export type ErrorClass = 'PERMANENT' | 'TRANSIENT';

/** Permanente: reenviar igual não adianta (HTTP 400/409; SQS → DLQ). Todo o resto é tratado como transitório. */
export function classifyError(err: unknown): ErrorClass {
  return err instanceof InvalidPayloadError || err instanceof IdempotencyConflictError ? 'PERMANENT' : 'TRANSIENT';
}
