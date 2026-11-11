import { describe, expect, test } from 'bun:test';
import { InvalidOutboxStateError } from '../../src/domain/errors';
import { WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference } from '../../src/domain/events';
import { InboxMessage } from '../../src/domain/inbox-message';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind as K } from '../../src/domain/wager-transaction';
import { FailureCode } from '../../src/domain/failure-codes';
import { Wallet } from '../../src/domain/wallet';

const m = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const now = new Date('2026-11-10T12:00:00Z');
const ctx = { correlationId: 'corr-1', causationId: 'cause-1', now };

const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: m('100'), at: now });
const tx = WagerTransaction.create({
  id: 't1', providerId: 'provider-a', externalTransactionId: 'e1', idempotencyKey: 'k', payloadHash: 'h', walletId: 'w1', playerId: 'p1',
  roundId: 'r', gameId: 'g', kind: K.Refund, money: m('10'), referenceExternalTransactionId: 'e0',
});

describe('eventos de integração', () => {
  test('envelope: tipo e versão ficam na classe; data carrega MoneyProps (nunca Money)', () => {
    const entry = wallet.debit({ money: m('10'), transactionId: 't1', entryId: 'le1', at: now });
    const ev = WalletBalanceChanged.from(wallet, entry, ctx);
    const json = ev.toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('w1');
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('cause-1');
    expect(json.occurredAt).toBe('2026-11-10T12:00:00.000Z');
    expect(json.data).toEqual({
      walletId: 'w1', transactionId: 't1', direction: 'DEBIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '90.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(JSON.parse(JSON.stringify(ev))).toEqual(json); // JSON estável
  });

  test('Processed, Rejected e PendingReference', () => {
    expect(WagerTransactionProcessed.from(tx, ctx).toJSON().eventType).toBe('WagerTransactionProcessed');
    const pend = WagerTransactionPendingReference.from(tx, ctx).toJSON();
    expect(pend.eventType).toBe('WagerTransactionPendingReference');
    expect(pend.data.referenceExternalTransactionId).toBe('e0');
    const rejected = WagerTransaction.create({ ...{ id: 't2', providerId: 'p', externalTransactionId: 'e2', idempotencyKey: 'k2', payloadHash: 'h', walletId: 'w1', playerId: 'p1', roundId: 'r', gameId: 'g', kind: K.Bet, money: m('1') } });
    rejected.reject(FailureCode.InsufficientFunds, now);
    expect(WagerTransactionRejected.from(rejected, ctx).toJSON().data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('eventIds são únicos', () => {
    expect(WagerTransactionProcessed.from(tx, ctx).eventId).not.toBe(WagerTransactionProcessed.from(tx, ctx).eventId);
  });
});

describe('OutboxMessage', () => {
  const mkOutbox = () => OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx));

  test('enqueue: pendente e devido imediatamente; id == eventId', () => {
    const ev = WagerTransactionProcessed.from(tx, ctx);
    const o = OutboxMessage.enqueue(ev);
    expect(o.id).toBe(ev.eventId);
    expect(o.isPending()).toBe(true);
    expect(o.isDue(now)).toBe(true);
    expect(o.attempts).toBe(0);
  });

  test('scheduleRetry: incrementa attempts e aplica backoff exponencial', () => {
    const o = mkOutbox();
    o.scheduleRetry(now);
    const d1 = o.nextAttemptAt!.getTime() - now.getTime();
    o.scheduleRetry(now);
    const d2 = o.nextAttemptAt!.getTime() - now.getTime();
    expect(o.attempts).toBe(2);
    expect(d2).toBe(d1 * 2);
    expect(o.isDue(now)).toBe(false);
    expect(o.isDue(new Date(now.getTime() + d2))).toBe(true);
  });

  test('backoff é limitado', () => {
    const o = mkOutbox();
    for (let i = 0; i < 40; i++) o.scheduleRetry(now);
    expect(o.nextAttemptAt!.getTime() - now.getTime()).toBeLessThanOrEqual(5 * 60_000);
  });

  test('markPublished: deixa de ser pendente; não republica nem agenda retry', () => {
    const o = mkOutbox();
    o.markPublished(now);
    expect(o.isPending()).toBe(false);
    expect(o.publishedAt).toEqual(now);
    expect(() => o.markPublished(now)).toThrow(InvalidOutboxStateError);
    expect(() => o.scheduleRetry(now)).toThrow(InvalidOutboxStateError);
  });
});

describe('InboxMessage', () => {
  test('receive → markProcessed uma vez', () => {
    const i = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: now });
    expect(i.isProcessed()).toBe(false);
    i.markProcessed(now);
    expect(i.isProcessed()).toBe(true);
    expect(i.processedAt).toEqual(now);
    expect(() => i.markProcessed(now)).toThrow(InvalidOutboxStateError);
  });
});
