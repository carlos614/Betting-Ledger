import { z } from 'zod';
import { isTransientInfrastructureError } from '../application/error-classification';
import { logEvent } from '../application/log';
import type { MetricsService } from '../application/metrics';
import type { TransactionQueries } from '../application/transaction-queries';
import {
  CreateWalletSchema, IdempotencyKeySchema, TransactionBodySchema, parseOrThrow, providerId as providerIdSchema,
} from '../application/validation';
import type { TransactionResult, WagerProcessor } from '../application/wager-processor';
import type { WalletService } from '../application/wallet-service';
import { DomainError, IdempotencyConflictError, InvalidPayloadError, NotFoundError, WalletAlreadyExistsError } from '../domain/errors';
import { FAILURE_ADVICE, type FailureCode } from '../domain/failure-codes';
import { WagerTransactionStatus as S } from '../domain/wager-transaction';

/**
 * Camada HTTP independente de framework: cada método devolve {status, headers, body}.
 * Os controllers do NestJS são adaptadores finos sobre esta classe, e TODO o mapeamento de status
 * mora aqui, então é idêntico em todos os endpoints.
 *
 * ┌─────┬─────────────────────────────┬───────────────────────────────────────────────┬──────────────────────────────┐
 * │ HTTP│ situação                    │ corpo                                         │ o que o provedor faz         │
 * ├─────┼─────────────────────────────┼───────────────────────────────────────────────┼──────────────────────────────┤
 * │ 200 │ PROCESSED (ou replay)       │ {transactionId,status,balance,idempotentReplay}│ nada: concluído              │
 * │ 201 │ wallet criada               │ wallet                                        │ nada                         │
 * │ 202 │ PENDING_REFERENCE (aceito)  │ idem + Location                               │ NÃO reenviar; consultar GET  │
 * │ 400 │ payload inválido            │ {error:{code:INVALID_PAYLOAD,…}}              │ corrigir; não reenviar igual │
 * │ 404 │ recurso inexistente         │ {error:{code:NOT_FOUND}}                      │ —                            │
 * │ 409 │ conflito de idempotência    │ {error:{code:IDEMPOTENCY_CONFLICT}}           │ NÃO reenviar com a mesma key │
 * │     │ / wallet duplicada          │ {error:{code:WALLET_ALREADY_EXISTS}}          │                              │
 * │ 422 │ rejeitada por regra         │ {…,status:REJECTED,failureCode,advice}        │ ver failureCode / advice     │
 * │ 503 │ falha transitória           │ {error:{code:TRANSIENT_FAILURE,retryable}}+RA │ reenviar a MESMA key (seguro)│
 * │ 500 │ erro interno / FAILED       │ {error:{code:INTERNAL_ERROR}}                 │ contatar suporte             │
 * └─────┴─────────────────────────────┴───────────────────────────────────────────────┴──────────────────────────────┘
 */
export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface Readiness {
  name: string;
  check: () => Promise<void>;
}

const uuid = z.string().uuid();

export class WageringApi {
  constructor(
    private readonly processor: WagerProcessor,
    private readonly wallets: WalletService,
    private readonly queries: TransactionQueries,
    private readonly metrics: MetricsService,
    private readonly readiness: Readiness[] = [],
  ) {}

  // ------------------------------------------------------------------ wallets

  createWallet(body: unknown, correlationId: string): Promise<ApiResponse> {
    return this.guard(correlationId, async () => {
      const input = parseOrThrow(CreateWalletSchema, body, 'request body');
      return { status: 201, body: await this.wallets.create(input, correlationId) };
    });
  }

  getWallet(walletId: string, correlationId: string): Promise<ApiResponse> {
    return this.guard(correlationId, async () => ({
      status: 200,
      body: await this.wallets.get(parseOrThrow(uuid, walletId, 'walletId')),
    }));
  }

  getLedger(walletId: string, query: { cursor?: string | undefined; limit?: string | undefined }, correlationId: string): Promise<ApiResponse> {
    return this.guard(correlationId, async () => {
      const id = parseOrThrow(uuid, walletId, 'walletId');
      let limit: number | undefined;
      if (query.limit !== undefined) {
        if (!/^\d{1,4}$/.test(query.limit)) throw new InvalidPayloadError('limit must be an integer between 1 and 200');
        limit = Number(query.limit);
      }
      return { status: 200, body: await this.wallets.ledger(id, query.cursor || undefined, limit) };
    });
  }

  reconcile(walletId: string, correlationId: string): Promise<ApiResponse> {
    return this.guard(correlationId, async () => ({
      status: 200,
      body: await this.wallets.reconcile(parseOrThrow(uuid, walletId, 'walletId'), correlationId),
    }));
  }

  // ------------------------------------------------------------------ transações

  submitTransaction(idempotencyKey: string | undefined, body: unknown, correlationId: string): Promise<ApiResponse> {
    return this.guard(correlationId, async () => {
      if (idempotencyKey === undefined || idempotencyKey === '') throw new InvalidPayloadError('Idempotency-Key header is required');
      const key = parseOrThrow(IdempotencyKeySchema, idempotencyKey, 'Idempotency-Key header');
      const parsed = parseOrThrow(TransactionBodySchema, body, 'request body');
      const result = await this.processor.execute({ ...parsed, idempotencyKey: key, correlationId, source: { type: 'http' } });
      return transactionResponse(result);
    });
  }

  getTransaction(transactionId: string, correlationId: string): Promise<ApiResponse> {
    return this.guard(correlationId, async () => ({
      status: 200,
      body: await this.queries.byId(parseOrThrow(uuid, transactionId, 'transactionId')),
    }));
  }

  getProviderTransaction(providerId: string, externalTransactionId: string, correlationId: string): Promise<ApiResponse> {
    return this.guard(correlationId, async () => ({
      status: 200,
      body: await this.queries.byExternalId(
        parseOrThrow(providerIdSchema, providerId, 'providerId'),
        parseOrThrow(z.string().min(1).max(128).regex(/^\S+$/), externalTransactionId, 'externalTransactionId'),
      ),
    }));
  }

  // ------------------------------------------------------------------ saúde (sem autenticação)

  live(): ApiResponse {
    return { status: 200, body: { status: 'ok' } };
  }

  async ready(): Promise<ApiResponse> {
    const checks: Record<string, 'up' | 'down'> = {};
    await Promise.all(
      this.readiness.map(async (r) => {
        try {
          await withTimeout(r.check(), 2_000);
          checks[r.name] = 'up';
        } catch {
          checks[r.name] = 'down';
        }
      }),
    );
    const ok = Object.values(checks).every((v) => v === 'up');
    return { status: ok ? 200 : 503, ...(ok ? {} : { headers: { 'retry-after': '5' } }), body: { status: ok ? 'ok' : 'unavailable', checks } };
  }

  metricsText(): string {
    return this.metrics.render();
  }

  // ------------------------------------------------------------------ erros

  /** Único ponto de tradução exceção → HTTP. */
  private async guard(correlationId: string, fn: () => Promise<ApiResponse>): Promise<ApiResponse> {
    try {
      const res = await fn();
      return { ...res, headers: { 'x-correlation-id': correlationId, ...res.headers } };
    } catch (err) {
      return { ...toErrorResponse(err, correlationId), headers: { 'x-correlation-id': correlationId, ...errorHeaders(err) } };
    }
  }
}

function transactionResponse(r: TransactionResult): ApiResponse {
  const body: Record<string, unknown> = {
    transactionId: r.transactionId,
    status: r.status,
    ...(r.balance ? { balance: r.balance } : {}),
    ...(r.failureCode ? { failureCode: r.failureCode, advice: FAILURE_ADVICE[r.failureCode as FailureCode] } : {}),
    idempotentReplay: r.idempotentReplay,
  };
  switch (r.status) {
    case S.Processed:
      return { status: 200, body };
    case S.Rejected:
      return { status: 422, body };
    case S.Failed:
      return { status: 500, body };
    default: // PENDING / PENDING_REFERENCE: aceito, processamento pendente
      return { status: 202, headers: { location: `/wagering/transactions/${r.transactionId}` }, body };
  }
}

export function errorBody(code: string, message: string, retryable: boolean, details?: unknown) {
  return { error: { code, message, retryable, ...(details !== undefined ? { details } : {}) } };
}

const errorHeaders = (err: unknown): Record<string, string> =>
  isTransientInfrastructureError(err) && !isKnownError(err) ? { 'retry-after': '1' } : {};

const isKnownError = (err: unknown): boolean =>
  err instanceof InvalidPayloadError || err instanceof IdempotencyConflictError || err instanceof WalletAlreadyExistsError ||
  err instanceof NotFoundError || err instanceof DomainError;

export function toErrorResponse(err: unknown, correlationId: string): ApiResponse {
  if (err instanceof InvalidPayloadError) return { status: 400, body: errorBody('INVALID_PAYLOAD', err.message, false, err.details) };
  if (err instanceof IdempotencyConflictError) return { status: 409, body: errorBody('IDEMPOTENCY_CONFLICT', err.message, false) };
  if (err instanceof WalletAlreadyExistsError) return { status: 409, body: errorBody('WALLET_ALREADY_EXISTS', err.message, false) };
  if (err instanceof NotFoundError) return { status: 404, body: errorBody('NOT_FOUND', err.message, false) };
  if (err instanceof DomainError) return { status: 422, body: errorBody(err.code, err.message, false) };
  if (isTransientInfrastructureError(err)) {
    logEvent('warn', 'transient infrastructure failure', { correlationId, error: (err as Error)?.message });
    return { status: 503, body: errorBody('TRANSIENT_FAILURE', 'temporary failure; retry the same request with the same Idempotency-Key', true) };
  }
  logEvent('error', 'unexpected error', { correlationId, error: (err as Error)?.message, stack: (err as Error)?.stack });
  return { status: 500, body: errorBody('INTERNAL_ERROR', 'unexpected internal error', false) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
