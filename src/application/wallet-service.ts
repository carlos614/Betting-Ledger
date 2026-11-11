import { randomUUID } from 'node:crypto';
import { InvalidPayloadError, NotFoundError, WalletAlreadyExistsError } from '../domain/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import { computePayloadHash } from '../domain/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { SqlExecutor, TransactionRunner } from '../infra/persistence/ports';
import { logEvent } from './log';
import type { MetricsService } from './metrics';
import {
  enqueueEvent, insertLedgerEntry, insertTransaction, insertWallet, saveTransaction, toDate, toLedgerEntry, toWallet,
  type LedgerRow, type WalletRow,
} from './repositories';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Opaco. `null` quando não há mais páginas. */
  nextCursor: string | null;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export const OPENING_PROVIDER = 'system';
export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export class WalletService {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Cria a wallet. Com saldo inicial > 0, a transação interna OPENING, o lançamento CREDIT, os eventos
   * da outbox e a própria wallet são gravados na MESMA transação SQL.
   */
  async create(input: { playerId: string; initialBalance: MoneyProps }, correlationId: string): Promise<WalletView> {
    const now = new Date();
    const initial = Money.from(input.initialBalance);
    const wallet = Wallet.open({ id: randomUUID(), playerId: input.playerId, initialBalance: initial, at: now });

    await this.runner.transactional(async (db) => {
      if (!(await insertWallet(db, wallet))) throw new WalletAlreadyExistsError(input.playerId, initial.currency);
      if (initial.isPositive()) await this.recordOpening(db, wallet, initial, now, correlationId);
    });

    logEvent('info', 'wallet created', { correlationId, walletId: wallet.id });
    return toWalletView(wallet);
  }

  async get(walletId: string): Promise<WalletView> {
    const rows = await this.runner.transactional((db) =>
      db.execute<WalletRow>(
        `select id, player_id, currency, balance::text as balance, version, created_at, updated_at from wallets where id = ?`,
        [walletId],
      ),
    );
    if (!rows[0]) throw new NotFoundError('wallet');
    return toWalletView(toWallet(rows[0]));
  }

  /** Razão paginado por cursor opaco e estável (ordenado por wallet_version, único e monotônico por wallet). */
  async ledger(walletId: string, cursor: string | undefined, limit: number = DEFAULT_LEDGER_LIMIT): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new InvalidPayloadError(`limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`);
    }
    const after = cursor === undefined ? 0 : decodeCursor(cursor);

    const { exists, rows } = await this.runner.transactional(async (db) => {
      const w = await db.execute(`select 1 as x from wallets where id = ?`, [walletId]);
      const entries = await db.execute<LedgerRow>(
        `select e.id, e.wallet_id, e.transaction_id, e.direction, e.amount::text as amount, e.balance_before::text as balance_before,
                e.balance_after::text as balance_after, e.wallet_version, e.created_at, w.currency
           from wallet_ledger_entries e join wallets w on w.id = e.wallet_id
          where e.wallet_id = ? and e.wallet_version > ?
          order by e.wallet_version asc limit ?`,
        [walletId, after, limit + 1],
      );
      return { exists: w.length > 0, rows: entries };
    });
    if (!exists) throw new NotFoundError('wallet');

    const page = rows.slice(0, limit).map(toLedgerEntry);
    const last = page[page.length - 1];
    return {
      items: page.map(toLedgerEntryView),
      nextCursor: rows.length > limit && last ? encodeCursor(last.walletVersion) : null,
    };
  }

  /**
   * Compara o saldo materializado com o saldo reconstruído do razão, numa ÚNICA consulta (um snapshot
   * consistente, sem travar a wallet). Divergências NÃO são corrigidas: são logadas, contadas e sinalizadas.
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationResult> {
    const rows = await this.runner.transactional((db) =>
      db.execute<{ currency: string; stored: string; calculated: string; entries: string }>(
        `select w.currency, w.balance::text as stored,
                coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)::text as calculated,
                count(e.id)::text as entries
           from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
          where w.id = ? group by w.id, w.currency, w.balance`,
        [walletId],
      ),
    );
    const r = rows[0];
    if (!r) throw new NotFoundError('wallet');

    const stored = Money.fromSigned({ amount: r.stored, currency: r.currency });
    const calculated = Money.fromSigned({ amount: r.calculated, currency: r.currency });
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    const result: ReconciliationResult = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: Number(r.entries),
    };

    this.metrics.inc('wager_reconciliations_total', { result: consistent ? 'consistent' : 'divergent' });
    if (!consistent) {
      this.metrics.inc('wager_reconciliation_divergences_total');
      logEvent('error', 'RECONCILIATION DIVERGENCE: stored balance differs from ledger', {
        correlationId, walletId, difference: result.difference.amount, checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }

  // ------------------------------------------------------------------ interno

  private async recordOpening(db: SqlExecutor, wallet: Wallet, initial: Money, now: Date, correlationId: string): Promise<void> {
    const external = `opening:${wallet.id}`;
    const tx = WagerTransaction.create(
      {
        id: randomUUID(),
        providerId: OPENING_PROVIDER,
        externalTransactionId: external,
        idempotencyKey: `${OPENING_PROVIDER}:${external}`,
        payloadHash: computePayloadHash({
          providerId: OPENING_PROVIDER, externalTransactionId: external, playerId: wallet.playerId, walletId: wallet.id,
          roundId: 'opening', gameId: 'opening', kind: WagerTransactionKind.Opening, money: initial.toJSON(),
        }),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money: initial,
        createdAt: now,
      },
      { internal: true },
    );
    await insertTransaction(db, tx, correlationId);
    tx.markProcessed(undefined, now, initial);
    await saveTransaction(db, tx);

    const entry = WalletLedgerEntry.create({
      id: randomUUID(), walletId: wallet.id, transactionId: tx.id, direction: LedgerDirection.Credit, money: initial,
      balanceBefore: Money.zero(initial.currency), balanceAfter: initial, walletVersion: wallet.version, createdAt: now,
    });
    await insertLedgerEntry(db, entry);

    const ctx = { correlationId, now };
    await enqueueEvent(db, WagerTransactionProcessed.from(tx, ctx));
    await enqueueEvent(db, WalletBalanceChanged.from(wallet, entry, ctx));
  }
}

const toWalletView = (w: Wallet): WalletView => ({ id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version });

const toLedgerEntryView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});

/** Cursor opaco: base64url de {v: última wallet_version vista}. O cliente não deve interpretá-lo. */
export function encodeCursor(version: number): string {
  return Buffer.from(JSON.stringify({ v: version }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v >= 0) return parsed.v;
  } catch {
    /* cai no erro abaixo */
  }
  throw new InvalidPayloadError('invalid cursor');
}

export { toDate };
