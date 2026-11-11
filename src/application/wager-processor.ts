import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError, InsufficientFundsError } from '../domain/errors';
import { WagerTransactionProcessed, WagerTransactionPendingReference, WagerTransactionRejected, WalletBalanceChanged, type EventContext, type IntegrationEvent } from '../domain/events';
import { FailureCode } from '../domain/failure-codes';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { computePayloadHash } from '../domain/payload-hash';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../domain/wager-transaction';
import type { SqlExecutor, TransactionRunner } from '../infra/persistence/ports';
import { isLockConflict, sqlState } from './error-classification';
import { logEvent } from './log';
import type { MetricsService } from './metrics';
import {
  findExistingForIdempotency, findTransactionById, hasProcessedReversalOf, insertLedgerEntry, insertOutbox, insertTransaction,
  lockWallet, saveTransaction, toTransaction, updateWallet, findTransactionByExternalId, type WagerTxRow,
} from './repositories';
import type { TransactionBody } from './validation';

export interface WagerProcessorOptions {
  /** Limite de reavaliações de uma referência ausente (PENDING_REFERENCE). Padrão 8. */
  pendingMaxAttempts: number;
  /** Atraso base do backoff exponencial entre reavaliações. Padrão 5 s (5·2ⁿ, teto abaixo). */
  pendingBaseDelaySeconds: number;
  pendingMaxDelaySeconds: number;
  /** TTL total desde a criação, independentemente do nº de tentativas. Padrão 30 min. */
  pendingTtlSeconds: number;
  lockTimeoutMs: number;
}

export const DEFAULT_OPTIONS: WagerProcessorOptions = {
  pendingMaxAttempts: 8,
  pendingBaseDelaySeconds: 5,
  pendingMaxDelaySeconds: 300,
  pendingTtlSeconds: 1800,
  lockTimeoutMs: 10_000,
};

export type TransactionSource = { type: 'http' } | { type: 'sqs'; consumerName: string; messageId: string };

export interface SubmitCommand extends TransactionBody {
  idempotencyKey: string;
  correlationId: string;
  source: TransactionSource;
}

export interface TransactionResult {
  transactionId: string;
  status: S;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

type Mode = 'new' | 'worker' | 'drain';
interface Outcome { status: S; kind: K }
interface ApplyContext {
  mode: Mode;
  correlationId: string;
  causationId?: string;
  now: Date;
  outcomes: Outcome[];
}

type RefResolution =
  | { kind: 'ok'; reference: WagerTransaction }
  | { kind: 'wait'; code: FailureCode }
  | { kind: 'reject'; code: FailureCode };

/** Quais tipos cada operação pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<K, readonly K[]>> = {
  [K.Opening]: [],
  [K.Bet]: [],
  [K.Win]: [K.Bet],
  [K.Loss]: [K.Bet],
  [K.Refund]: [K.Bet],
  [K.Rollback]: [K.Bet, K.Win, K.Refund],
};

/**
 * Caso de uso ÚNICO de processamento (HTTP e SQS chamam o mesmo `execute`).
 *
 * Tudo — inbox, transação, saldo, lançamento e outbox — acontece numa transação PostgreSQL.
 * Ordem de locks (sempre a mesma ⇒ sem deadlock entre transações do sistema):
 *   1. linha da wallet  (SELECT … FOR UPDATE)   ← unidade de concorrência
 *   2. linhas de wager_transactions pendentes que dependem desta transação (drain)
 * Duplicatas são decididas pelos índices únicos do banco, nunca por cache em memória.
 */
export class WagerProcessor {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: MetricsService,
    private readonly opts: WagerProcessorOptions = DEFAULT_OPTIONS,
  ) {}

  // ================================================================== entrada

  async execute(cmd: SubmitCommand): Promise<TransactionResult> {
    const started = performance.now();
    const payloadHash = computePayloadHash(cmd);
    const outcomes: Outcome[] = [];
    let result: TransactionResult;
    try {
      result = await this.runner.transactional((db) => this.executeInTx(db, cmd, payloadHash, outcomes));
    } catch (err) {
      if (isLockConflict(err)) this.metrics.inc('wager_lock_conflicts_total', { type: sqlState(err) ?? 'unknown' });
      if (err instanceof IdempotencyConflictError) this.metrics.inc('wager_duplicates_total', { kind: 'payload_conflict' });
      throw err;
    }
    this.flush(outcomes);
    if (result.idempotentReplay) this.metrics.inc('wager_duplicates_total', { kind: cmd.source.type === 'sqs' ? 'sqs_message_or_key' : 'http_replay' });
    this.metrics.observe('wager_processing_duration_seconds', (performance.now() - started) / 1000);
    logEvent('info', 'transaction handled', {
      correlationId: cmd.correlationId,
      messageId: cmd.source.type === 'sqs' ? cmd.source.messageId : undefined,
      transactionId: result.transactionId,
      walletId: cmd.walletId,
      providerId: cmd.providerId,
      kind: cmd.kind,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
    return result;
  }

  private async executeInTx(db: SqlExecutor, cmd: SubmitCommand, payloadHash: string, outcomes: Outcome[]): Promise<TransactionResult> {
    const now = new Date();
    await this.setLockTimeout(db);

    // 1) inbox (somente SQS): deduplicação persistente por (consumerName, messageId)
    if (cmd.source.type === 'sqs') {
      const inserted = await db.execute(
        `insert into inbox_messages (message_id, consumer_name, payload_hash, received_at)
         values (?, ?, ?, ?::timestamptz) on conflict do nothing returning message_id`,
        [cmd.source.messageId, cmd.source.consumerName, payloadHash, now.toISOString()],
      );
      if (inserted.length === 0) {
        const seen = await db.execute<{ payload_hash: string }>(
          `select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`,
          [cmd.source.consumerName, cmd.source.messageId],
        );
        if (seen[0] && seen[0].payload_hash.trim() !== payloadHash) {
          throw new IdempotencyConflictError(`messageId ${cmd.source.messageId} was reused with a different payload`);
        }
        const existing = await findExistingForIdempotency(db, cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId);
        if (!existing) throw new Error(`inbox has message ${cmd.source.messageId} but no transaction was found`);
        return rowToResult(existing, true);
      }
    }

    // 2) trava a wallet ANTES de qualquer outra escrita (ordem de locks fixa)
    await lockWallet(db, cmd.walletId);

    // 3) idempotência: a unicidade é decidida pelo banco
    const tx = WagerTransaction.create({
      id: randomUUID(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind as K,
      money: Money.from(cmd.money),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });
    if (!(await insertTransaction(db, tx, cmd.correlationId))) {
      const existing = await findExistingForIdempotency(db, cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId);
      if (!existing) throw new Error('conflicting transaction disappeared; retry'); // só se o dono deu rollback no meio
      if (existing.idempotency_key !== cmd.idempotencyKey || existing.payload_hash.trim() !== payloadHash) {
        throw new IdempotencyConflictError(
          existing.idempotency_key !== cmd.idempotencyKey
            ? `externalTransactionId ${cmd.externalTransactionId} already exists under a different Idempotency-Key`
            : `Idempotency-Key ${cmd.idempotencyKey} was already used with a different payload`,
          existing.id,
        );
      }
      return rowToResult(existing, true);
    }

    // 4) aplica regras de negócio
    await this.apply(db, tx, {
      mode: 'new',
      correlationId: cmd.correlationId,
      ...(cmd.source.type === 'sqs' ? { causationId: cmd.source.messageId } : {}),
      now,
      outcomes,
    });

    if (cmd.source.type === 'sqs') {
      await db.execute(`update inbox_messages set processed_at = ?::timestamptz where consumer_name = ? and message_id = ?`, [
        new Date().toISOString(), cmd.source.consumerName, cmd.source.messageId,
      ]);
    }
    return entityToResult(tx, false);
  }

  /**
   * Falha permanente de infraestrutura (tentativas esgotadas): grava a transação como FAILED,
   * terminal e auditável, e conta no metric. Best-effort: se já existe resultado, não faz nada.
   */
  async recordFailure(cmd: SubmitCommand, code: FailureCode = FailureCode.ProcessingExhausted): Promise<void> {
    const payloadHash = computePayloadHash(cmd);
    const now = new Date();
    await this.runner.transactional(async (db) => {
      await this.setLockTimeout(db);
      const tx = WagerTransaction.create({
        id: randomUUID(), providerId: cmd.providerId, externalTransactionId: cmd.externalTransactionId, idempotencyKey: cmd.idempotencyKey,
        payloadHash, walletId: cmd.walletId, playerId: cmd.playerId, roundId: cmd.roundId, gameId: cmd.gameId, kind: cmd.kind as K,
        money: Money.from(cmd.money), referenceExternalTransactionId: cmd.referenceExternalTransactionId, createdAt: now,
      });
      if (!(await insertTransaction(db, tx, cmd.correlationId))) return;
      tx.fail(code, now);
      await saveTransaction(db, tx);
    });
    this.metrics.inc('wager_transactions_total', { status: S.Failed, kind: cmd.kind });
    logEvent('error', 'transaction marked FAILED', {
      correlationId: cmd.correlationId, providerId: cmd.providerId, walletId: cmd.walletId, kind: cmd.kind, failureCode: code,
    });
  }

  // ================================================================== worker de PENDING_REFERENCE

  /** Reavalia transações aguardando referência cujo `next_attempt_at` venceu. Seguro com N instâncias. */
  async processDuePending(limit = 50): Promise<number> {
    const due = await this.runner.transactional((db) =>
      db.execute<{ id: string; wallet_id: string }>(
        `select id, wallet_id from wager_transactions where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
          order by next_attempt_at limit ?`,
        [limit],
      ),
    );
    let handled = 0;
    for (const item of due) {
      const outcomes: Outcome[] = [];
      try {
        await this.runner.transactional(async (db) => {
          await this.setLockTimeout(db);
          await lockWallet(db, item.wallet_id); // wallet primeiro (mesma ordem do caminho normal)
          const row = await findTransactionById(db, item.id, true);
          if (!row || row.status !== S.PendingReference) return; // outra instância já resolveu
          const tx = toTransaction(row);
          await this.apply(db, tx, { mode: 'worker', correlationId: row.correlation_id ?? tx.id, now: new Date(), outcomes });
          handled += 1;
        });
        this.flush(outcomes);
      } catch (err) {
        if (isLockConflict(err)) this.metrics.inc('wager_lock_conflicts_total', { type: sqlState(err) ?? 'unknown' });
        logEvent('error', 'pending-reference retry failed', { transactionId: item.id, error: (err as Error).message });
      }
    }
    return handled;
  }

  // ================================================================== regras de negócio

  private async apply(db: SqlExecutor, tx: WagerTransaction, ctx: ApplyContext): Promise<void> {
    const wallet = await lockWallet(db, tx.walletId);
    if (!wallet) return this.rejectTx(db, tx, FailureCode.WalletNotFound, undefined, ctx);
    if (wallet.playerId !== tx.playerId) return this.rejectTx(db, tx, FailureCode.PlayerMismatch, wallet.balance, ctx);
    if (wallet.currency !== tx.money.currency) return this.rejectTx(db, tx, FailureCode.CurrencyMismatch, wallet.balance, ctx);

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      const res = await this.resolveReference(db, tx);
      if (res.kind === 'reject') return this.rejectTx(db, tx, res.code, wallet.balance, ctx);
      if (res.kind === 'wait') return this.waitForReference(db, tx, wallet.balance, res.code, ctx);
      reference = res.reference;
    }

    // ---- efeito no saldo
    let entry: WalletLedgerEntry | undefined;
    const previousVersion = wallet.version;
    if (tx.affectsBalance()) {
      const direction = tx.ledgerDirectionFor(reference);
      const movement = { money: tx.money, transactionId: tx.id, entryId: randomUUID(), at: ctx.now };
      try {
        entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          // BET sem saldo e ROLLBACK que debitaria além do saldo são situações operacionais distintas
          const code = tx.kind === K.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
          return this.rejectTx(db, tx, code, wallet.balance, ctx);
        }
        throw err;
      }
      await updateWallet(db, wallet, previousVersion);
    }

    tx.markProcessed(reference?.id, ctx.now, wallet.balance);
    await saveTransaction(db, tx); // PROCESSED antes do lançamento: o trigger deferido exige ambos no COMMIT
    if (entry) await insertLedgerEntry(db, entry);

    const ev = this.eventContext(ctx);
    await this.enqueue(db, WagerTransactionProcessed.from(tx, ev));
    if (entry) await this.enqueue(db, WalletBalanceChanged.from(wallet, entry, ev));
    ctx.outcomes.push({ status: S.Processed, kind: tx.kind });

    // quem estava esperando por esta transação (mesma wallet) pode ser aplicado agora
    await this.drainDependents(db, tx, ctx);
  }

  private async resolveReference(db: SqlExecutor, tx: WagerTransaction): Promise<RefResolution> {
    const row = await findTransactionByExternalId(db, tx.providerId, tx.referenceExternalTransactionId as string);
    if (!row) return { kind: 'wait', code: FailureCode.ReferenceNotFound };
    const ref = toTransaction(row);

    if (!ALLOWED_REFERENCE_KINDS[tx.kind].includes(ref.kind)) return { kind: 'reject', code: FailureCode.InvalidReferenceKind };
    if (ref.walletId !== tx.walletId) return { kind: 'reject', code: FailureCode.ReferenceWalletMismatch };
    if (ref.playerId !== tx.playerId) return { kind: 'reject', code: FailureCode.ReferencePlayerMismatch };
    if (ref.money.currency !== tx.money.currency) return { kind: 'reject', code: FailureCode.ReferenceCurrencyMismatch };
    if (ref.roundId !== tx.roundId) return { kind: 'reject', code: FailureCode.ReferenceRoundMismatch };

    if (ref.status === S.Pending || ref.status === S.PendingReference) return { kind: 'wait', code: FailureCode.ReferenceNotProcessed };
    if (ref.status !== S.Processed) return { kind: 'reject', code: FailureCode.ReferenceNotProcessed };

    if (tx.requiresReference() && !ref.money.equals(tx.money)) return { kind: 'reject', code: FailureCode.ReferenceAmountMismatch };
    if (await hasProcessedReversalOf(db, ref.id, tx.id)) return { kind: 'reject', code: FailureCode.AlreadyReversed };
    return { kind: 'ok', reference: ref };
  }

  private async waitForReference(db: SqlExecutor, tx: WagerTransaction, balance: Money, code: FailureCode, ctx: ApplyContext): Promise<void> {
    if (ctx.mode === 'drain') return; // a referência ainda não resolveu: continua aguardando, sem gastar tentativa
    const ev = this.eventContext(ctx);

    if (ctx.mode === 'new') {
      tx.markPendingReference(addSeconds(ctx.now, this.opts.pendingBaseDelaySeconds));
      await saveTransaction(db, tx);
      await this.enqueue(db, WagerTransactionPendingReference.from(tx, ev));
      ctx.outcomes.push({ status: S.PendingReference, kind: tx.kind });
      return;
    }

    // worker: limite de tentativas OU TTL esgotado ⇒ REJECTED com código que identifica a causa
    const nextAttempt = tx.attempts + 1;
    const ageSeconds = (ctx.now.getTime() - tx.createdAt.getTime()) / 1000;
    if (nextAttempt >= this.opts.pendingMaxAttempts || ageSeconds >= this.opts.pendingTtlSeconds) {
      return this.rejectTx(db, tx, code, balance, ctx);
    }
    const delay = Math.min(this.opts.pendingBaseDelaySeconds * 2 ** nextAttempt, this.opts.pendingMaxDelaySeconds);
    tx.rescheduleReference(addSeconds(ctx.now, delay));
    await saveTransaction(db, tx);
    this.metrics.inc('wager_retries_total', { reason: 'pending_reference' });
  }

  private async rejectTx(db: SqlExecutor, tx: WagerTransaction, code: FailureCode, balance: Money | undefined, ctx: ApplyContext): Promise<void> {
    tx.reject(code, ctx.now, balance);
    await saveTransaction(db, tx);
    await this.enqueue(db, WagerTransactionRejected.from(tx, this.eventContext(ctx)));
    ctx.outcomes.push({ status: S.Rejected, kind: tx.kind });
  }

  private async drainDependents(db: SqlExecutor, tx: WagerTransaction, ctx: ApplyContext): Promise<void> {
    const rows = await db.execute<{ id: string }>(
      `select id from wager_transactions
        where provider_id = ? and reference_external_transaction_id = ? and wallet_id = ? and status = 'PENDING_REFERENCE'
        order by created_at, id for update`,
      [tx.providerId, tx.externalTransactionId, tx.walletId],
    );
    for (const r of rows) {
      const row = await findTransactionById(db, r.id);
      if (row && row.status === S.PendingReference) {
        await this.apply(db, toTransaction(row), { ...ctx, mode: 'drain', correlationId: row.correlation_id ?? ctx.correlationId, causationId: tx.id });
      }
    }
  }

  // ================================================================== utilidades

  private eventContext(ctx: ApplyContext): EventContext {
    return { correlationId: ctx.correlationId, ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}), now: ctx.now };
  }

  private enqueue(db: SqlExecutor, event: IntegrationEvent<unknown>): Promise<void> {
    return insertOutbox(db, OutboxMessage.enqueue(event));
  }

  private async setLockTimeout(db: SqlExecutor): Promise<void> {
    await db.execute(`set local lock_timeout = '${Math.max(1, Math.floor(this.opts.lockTimeoutMs))}ms'`);
  }

  private flush(outcomes: Outcome[]): void {
    for (const o of outcomes) this.metrics.inc('wager_transactions_total', { status: o.status, kind: o.kind });
  }
}

const addSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);

function entityToResult(tx: WagerTransaction, replay: boolean): TransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    idempotentReplay: replay,
  };
}

/** Replay devolve o resultado ORIGINAL, inclusive o saldo observado na época. */
export function rowToResult(row: WagerTxRow, replay: boolean): TransactionResult {
  return entityToResult(toTransaction(row), replay);
}
