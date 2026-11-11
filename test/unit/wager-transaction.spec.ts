import { describe, expect, test } from 'bun:test';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-codes';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { computePayloadHash } from '../../src/domain/payload-hash';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain/wager-transaction';

const m = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-10T12:00:00Z');
const mk = (kind: K, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}, internal = false) =>
  WagerTransaction.create(
    {
      id: 'tx', providerId: 'provider-a', externalTransactionId: 'ext-1', idempotencyKey: 'provider-a:ext-1', payloadHash: 'h',
      walletId: 'w', playerId: 'p', roundId: 'r1', gameId: 'g', kind, money: m('25'),
      ...(kind === K.Refund || kind === K.Rollback ? { referenceExternalTransactionId: 'ext-0' } : {}),
      ...extra,
    },
    { internal },
  );

describe('WagerTransaction: criação', () => {
  test('nasce em PENDING', () => {
    expect(mk(K.Bet).status).toBe(S.Pending);
  });

  test('REFUND e ROLLBACK exigem referência; BET/WIN/LOSS não', () => {
    expect(() => mk(K.Refund, { referenceExternalTransactionId: undefined })).toThrow(InvalidTransactionError);
    expect(() => mk(K.Rollback, { referenceExternalTransactionId: undefined })).toThrow(InvalidTransactionError);
    expect(mk(K.Refund).requiresReference()).toBe(true);
    expect(mk(K.Rollback).requiresReference()).toBe(true);
    expect(mk(K.Bet).requiresReference()).toBe(false);
    expect(mk(K.Win).requiresReference()).toBe(false);
    expect(mk(K.Win, { referenceExternalTransactionId: 'ext-0' }).referenceExternalTransactionId).toBe('ext-0'); // WIN pode referenciar
    expect(() => mk(K.Bet, { referenceExternalTransactionId: 'x' })).toThrow(InvalidTransactionError);
  });

  test('OPENING é interno: não pode ser criado "pela API"', () => {
    expect(() => mk(K.Opening)).toThrow(InvalidTransactionError);
    expect(mk(K.Opening, {}, true).kind).toBe(K.Opening);
  });

  test('valor deve ser positivo', () => {
    expect(() => mk(K.Bet, { money: Money.zero('BRL') })).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction: transições', () => {
  test('PENDING → PROCESSED / REJECTED / FAILED / PENDING_REFERENCE', () => {
    const a = mk(K.Bet); a.markProcessed(undefined, at, m('75'));
    expect(a.status).toBe(S.Processed);
    expect(a.observedBalance?.toJSON().amount).toBe('75.00');
    expect(a.processedAt).toEqual(at);

    const b = mk(K.Bet); b.reject(FailureCode.InsufficientFunds, at);
    expect(b.status).toBe(S.Rejected);
    expect(b.failureCode).toBe('INSUFFICIENT_FUNDS');

    const c = mk(K.Bet); c.fail(FailureCode.ProcessingExhausted, at);
    expect(c.status).toBe(S.Failed);

    const d = mk(K.Refund); d.markPendingReference(at);
    expect(d.status).toBe(S.PendingReference);
    expect(d.nextAttemptAt).toEqual(at);
  });

  test('PENDING_REFERENCE → reagendar, PROCESSED ou REJECTED', () => {
    const t = mk(K.Refund); t.markPendingReference(at);
    t.rescheduleReference(new Date(at.getTime() + 5000));
    expect(t.attempts).toBe(1);
    t.markProcessed('ref-id', at);
    expect(t.referenceTransactionId).toBe('ref-id');
    const r = mk(K.Refund); r.markPendingReference(at); r.reject(FailureCode.ReferenceNotFound, at);
    expect(r.status).toBe(S.Rejected);
  });

  test('estados terminais não mudam: qualquer transição lança InvalidTransactionStateError', () => {
    for (const finish of [
      (t: WagerTransaction) => t.markProcessed(undefined, at),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at),
      (t: WagerTransaction) => t.fail(FailureCode.ProcessingExhausted, at),
    ]) {
      const t = mk(K.Bet);
      finish(t);
      expect(t.isTerminal()).toBe(true);
      expect(() => t.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
      expect(() => t.reject(FailureCode.InsufficientFunds, at)).toThrow(InvalidTransactionStateError);
      expect(() => t.fail(FailureCode.ProcessingExhausted, at)).toThrow(InvalidTransactionStateError);
      expect(() => t.markPendingReference(at)).toThrow(InvalidTransactionStateError);
    }
  });

  test('PENDING_REFERENCE não volta a PENDING_REFERENCE; PENDING não é reagendável', () => {
    const t = mk(K.Refund); t.markPendingReference(at);
    expect(() => t.markPendingReference(at)).toThrow(InvalidTransactionStateError);
    expect(() => mk(K.Refund).rescheduleReference(at)).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate não revalida transições', () => {
    const t = WagerTransaction.rehydrate({
      id: 'x', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h', walletId: 'w', playerId: 'p',
      roundId: 'r', gameId: 'g', kind: K.Bet, money: m('1'), referenceExternalTransactionId: undefined, createdAt: at,
      status: S.Processed, referenceTransactionId: undefined, failureCode: undefined, processedAt: at, attempts: 0, nextAttemptAt: undefined, observedBalance: undefined,
    });
    expect(t.isTerminal()).toBe(true);
  });
});

describe('WagerTransaction: consultas de domínio', () => {
  test('affectsBalance: false só para LOSS', () => {
    expect(mk(K.Loss).affectsBalance()).toBe(false);
    for (const k of [K.Bet, K.Win, K.Refund, K.Rollback]) expect(mk(k).affectsBalance()).toBe(true);
  });

  test('ledgerDirectionFor: ROLLBACK é o inverso da referência', () => {
    expect(mk(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(mk(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(mk(K.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rb = mk(K.Rollback);
    expect(rb.ledgerDirectionFor(mk(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(mk(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(mk(K.Refund))).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => mk(K.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test('matchesPayload', () => {
    expect(mk(K.Bet).matchesPayload('h')).toBe(true);
    expect(mk(K.Bet).matchesPayload('other')).toBe(false);
  });
});

describe('payload hash (idempotency key com payload divergente)', () => {
  const p = { providerId: 'provider-a', externalTransactionId: 'ext-1', playerId: 'p', walletId: 'w', roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };

  test('estável: ordem das chaves e escala do valor não importam', () => {
    const a = computePayloadHash(p);
    expect(computePayloadHash({ money: { currency: 'BRL', amount: '25' }, kind: 'BET', gameId: 'g', roundId: 'r', walletId: 'w', playerId: 'p', externalTransactionId: 'ext-1', providerId: 'provider-a' })).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('qualquer campo de negócio diferente muda o hash', () => {
    const a = computePayloadHash(p);
    expect(computePayloadHash({ ...p, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(a);
    expect(computePayloadHash({ ...p, roundId: 'r2' })).not.toBe(a);
    expect(computePayloadHash({ ...p, kind: 'WIN' })).not.toBe(a);
    expect(computePayloadHash({ ...p, referenceExternalTransactionId: 'x' })).not.toBe(a);
  });

  test('campos extras (header, messageId) não entram no hash', () => {
    const a = computePayloadHash(p);
    expect(computePayloadHash({ ...p, idempotencyKey: 'k1', messageId: 'm1' } as never)).toBe(a);
  });
});
