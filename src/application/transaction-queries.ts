import { NotFoundError } from '../domain/errors';
import type { FailureCode } from '../domain/failure-codes';
import type { MoneyProps } from '../domain/money';
import type { TransactionRunner } from '../infra/persistence/ports';
import { findTransactionByExternalId, findTransactionById, toTransaction } from './repositories';

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  attempts: number;
  createdAt: string;
  processedAt?: string;
}

export class TransactionQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async byId(transactionId: string): Promise<TransactionView> {
    const row = await this.runner.transactional((db) => findTransactionById(db, transactionId));
    if (!row) throw new NotFoundError('transaction');
    return toView(row);
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const row = await this.runner.transactional((db) => findTransactionByExternalId(db, providerId, externalTransactionId));
    if (!row) throw new NotFoundError('transaction');
    return toView(row);
  }
}

function toView(row: Parameters<typeof toTransaction>[0]): TransactionView {
  const t = toTransaction(row);
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
    ...(t.referenceExternalTransactionId ? { referenceExternalTransactionId: t.referenceExternalTransactionId } : {}),
    ...(t.referenceTransactionId ? { referenceTransactionId: t.referenceTransactionId } : {}),
    ...(t.failureCode ? { failureCode: t.failureCode } : {}),
    ...(t.observedBalance ? { balance: t.observedBalance.toJSON() } : {}),
    attempts: t.attempts,
    createdAt: t.createdAt.toISOString(),
    ...(t.processedAt ? { processedAt: t.processedAt.toISOString() } : {}),
  };
}
