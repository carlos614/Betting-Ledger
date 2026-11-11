import type { IntegrationEvent } from '../domain/events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import type { FailureCode } from '../domain/failure-codes';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { SqlExecutor } from '../infra/persistence/ports';

export const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const toDateOrUndef = (v: unknown): Date | undefined => (v === null || v === undefined ? undefined : toDate(v));
const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

// ------------------------------------------------------------------ wallets

const WALLET_COLUMNS = `id, player_id, currency, balance::text as balance, version, created_at, updated_at`;

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: Number(row.version),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}

/** SELECT … FOR UPDATE: trava a linha da carteira até o fim da transação (unidade de concorrência = walletId). */
export async function lockWallet(db: SqlExecutor, walletId: string): Promise<Wallet | null> {
  const rows = await db.execute<WalletRow>(`select ${WALLET_COLUMNS} from wallets where id = ? for update`, [walletId]);
  return rows[0] ? toWallet(rows[0]) : null;
}

export async function insertWallet(db: SqlExecutor, w: Wallet): Promise<boolean> {
  const rows = await db.execute(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?::numeric, ?, ?::timestamptz, ?::timestamptz)
     on conflict do nothing returning id`,
    [w.id, w.playerId, w.currency, w.balance.toDecimalString(), w.version, w.createdAt.toISOString(), w.updatedAt.toISOString()],
  );
  return rows.length === 1;
}

/** Update protegido por versão (defesa em profundidade além do lock): 0 linhas ⇒ violação de invariante. */
export async function updateWallet(db: SqlExecutor, w: Wallet, expectedVersion: number): Promise<void> {
  const rows = await db.execute(
    `update wallets set balance = ?::numeric, version = ?, updated_at = ?::timestamptz where id = ? and version = ? returning id`,
    [w.balance.toDecimalString(), w.version, w.updatedAt.toISOString(), w.id, expectedVersion],
  );
  if (rows.length !== 1) throw new Error(`lost update detected on wallet ${w.id} (expected version ${expectedVersion})`);
}

// ------------------------------------------------------------------ transações

export const WTX_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
  game_id, kind, amount::text as amount, currency, reference_external_transaction_id, reference_transaction_id, status,
  failure_code, attempts, next_attempt_at, result_balance::text as result_balance, correlation_id, created_at, processed_at`;

export interface WagerTxRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  attempts: number | string;
  next_attempt_at: Date | string | null;
  result_balance: string | null;
  correlation_id: string | null;
  created_at: Date | string;
  processed_at: Date | string | null;
}

export function toTransaction(row: WagerTxRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash.trim(),
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: toDate(row.created_at),
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: toDateOrUndef(row.processed_at),
    attempts: Number(row.attempts),
    nextAttemptAt: toDateOrUndef(row.next_attempt_at),
    observedBalance: row.result_balance === null ? undefined : Money.from({ amount: row.result_balance, currency: row.currency }),
  });
}

export async function findTransactionById(db: SqlExecutor, id: string, forUpdate = false): Promise<WagerTxRow | null> {
  const rows = await db.execute<WagerTxRow>(`select ${WTX_COLUMNS} from wager_transactions where id = ? ${forUpdate ? 'for update' : ''}`, [id]);
  return rows[0] ?? null;
}

export async function findTransactionByExternalId(db: SqlExecutor, providerId: string, externalId: string): Promise<WagerTxRow | null> {
  const rows = await db.execute<WagerTxRow>(
    `select ${WTX_COLUMNS} from wager_transactions where provider_id = ? and external_transaction_id = ?`,
    [providerId, externalId],
  );
  return rows[0] ?? null;
}

/** Linha existente por chave de idempotência OU por (provider, id externo); prefere a de mesma chave. */
export async function findExistingForIdempotency(
  db: SqlExecutor,
  idempotencyKey: string,
  providerId: string,
  externalId: string,
): Promise<WagerTxRow | null> {
  const rows = await db.execute<WagerTxRow>(
    `select ${WTX_COLUMNS} from wager_transactions
      where idempotency_key = ? or (provider_id = ? and external_transaction_id = ?)
      order by (idempotency_key = ?) desc limit 1`,
    [idempotencyKey, providerId, externalId, idempotencyKey],
  );
  return rows[0] ?? null;
}

/** Insere a transação em PENDING. `false` ⇒ já existia (idempotência decidida pelo banco). */
export async function insertTransaction(db: SqlExecutor, t: WagerTransaction, correlationId: string): Promise<boolean> {
  const rows = await db.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
        kind, amount, currency, reference_external_transaction_id, status, correlation_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, 'PENDING', ?, ?::timestamptz)
     on conflict do nothing returning id`,
    [
      t.id, t.providerId, t.externalTransactionId, t.idempotencyKey, t.payloadHash, t.walletId, t.playerId, t.roundId, t.gameId,
      t.kind, t.money.toDecimalString(), t.money.currency, t.referenceExternalTransactionId ?? null, correlationId, t.createdAt.toISOString(),
    ],
  );
  return rows.length === 1;
}

export async function saveTransaction(db: SqlExecutor, t: WagerTransaction): Promise<void> {
  const rows = await db.execute(
    `update wager_transactions
        set status = ?, failure_code = ?, reference_transaction_id = ?, attempts = ?, next_attempt_at = ?::timestamptz,
            result_balance = ?::numeric, processed_at = ?::timestamptz
      where id = ? returning id`,
    [
      t.status, t.failureCode ?? null, t.referenceTransactionId ?? null, t.attempts, iso(t.nextAttemptAt),
      t.observedBalance?.toDecimalString() ?? null, iso(t.processedAt), t.id,
    ],
  );
  if (rows.length !== 1) throw new Error(`transaction ${t.id} vanished during update`);
}

export async function hasProcessedReversalOf(db: SqlExecutor, referenceId: string, exceptId: string): Promise<boolean> {
  const rows = await db.execute(
    `select 1 as x from wager_transactions
      where reference_transaction_id = ? and kind in ('REFUND','ROLLBACK') and status = 'PROCESSED' and id <> ? limit 1`,
    [referenceId, exceptId],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------------ razão

export async function insertLedgerEntry(db: SqlExecutor, e: WalletLedgerEntry): Promise<void> {
  await db.execute(
    `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at)
     values (?, ?, ?, ?, ?::numeric, ?::numeric, ?::numeric, ?, ?::timestamptz)`,
    [
      e.id, e.walletId, e.transactionId, e.direction, e.money.toDecimalString(), e.balanceBefore.toDecimalString(),
      e.balanceAfter.toDecimalString(), e.walletVersion, e.createdAt.toISOString(),
    ],
  );
}

export interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number | string;
  created_at: Date | string;
  currency: string;
}

export function toLedgerEntry(r: LedgerRow): WalletLedgerEntry {
  const m = (a: string) => Money.from({ amount: a, currency: r.currency });
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    direction: r.direction as LedgerDirection,
    money: m(r.amount),
    balanceBefore: m(r.balance_before),
    balanceAfter: m(r.balance_after),
    walletVersion: Number(r.wallet_version),
    createdAt: toDate(r.created_at),
  });
}

// ------------------------------------------------------------------ outbox / inbox

/** Grava o evento na outbox, dentro da MESMA transação SQL da mudança financeira. */
export function enqueueEvent(db: SqlExecutor, event: IntegrationEvent<unknown>): Promise<void> {
  return insertOutbox(db, OutboxMessage.enqueue(event));
}

export async function insertOutbox(db: SqlExecutor, m: OutboxMessage): Promise<void> {
  await db.execute(
    `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
     values (?, ?, ?, ?::jsonb, ?::timestamptz, 0)`,
    [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt.toISOString()],
  );
}
