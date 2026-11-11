import { describe, expect, test } from 'bun:test';
import { InsufficientFundsError, InvalidLedgerEntryError, InvalidMoneyError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const at = new Date('2026-11-10T12:00:00Z');
const open = (initial = '100.00') => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: m(initial), at });
const mv = (amount: string, n = 1) => ({ money: m(amount), transactionId: `t${n}`, entryId: `e${n}`, at });

describe('Wallet', () => {
  test('open: version 1 e saldo inicial', () => {
    const w = open('1000.00');
    expect(w.version).toBe(1);
    expect(w.balance.toJSON().amount).toBe('1000.00');
    expect(w.currency).toBe('BRL');
  });

  test('débito gera lançamento DEBIT, incrementa version e reduz o saldo', () => {
    const w = open();
    const e = w.debit(mv('30'));
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.balanceBefore.toJSON().amount).toBe('100.00');
    expect(e.balanceAfter.toJSON().amount).toBe('70.00');
    expect(e.walletVersion).toBe(2);
    expect(w.version).toBe(2);
    expect(w.balance.toJSON().amount).toBe('70.00');
  });

  test('crédito gera lançamento CREDIT e encadeia com o anterior', () => {
    const w = open();
    const d = w.debit(mv('30', 1));
    const c = w.credit(mv('5', 2));
    expect(c.direction).toBe(LedgerDirection.Credit);
    expect(c.balanceBefore.equals(d.balanceAfter)).toBe(true);
    expect(c.walletVersion).toBe(3);
    expect(w.balance.toJSON().amount).toBe('75.00');
  });

  test('nunca saldo negativo; falha não muta estado nem version', () => {
    const w = open('10.00');
    expect(() => w.debit(mv('10.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.toJSON().amount).toBe('10.00');
    expect(w.version).toBe(1);
    expect(w.debit(mv('10.00')).balanceAfter.isZero()).toBe(true);
  });

  test('moeda diferente e valor não positivo são rejeitados', () => {
    const w = open();
    expect(() => w.debit({ ...mv('1'), money: m('1', 'USD') })).toThrow(InvalidMoneyError);
    expect(() => w.credit({ ...mv('1'), money: m('1', 'USD') })).toThrow(InvalidMoneyError);
    expect(() => w.credit({ ...mv('0'), money: Money.zero('BRL') })).toThrow(InvalidMoneyError);
    expect(w.version).toBe(1);
  });

  test('rehydrate não revalida e preserva version', () => {
    const w = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: m('5'), version: 7, createdAt: at, updatedAt: at });
    expect(w.version).toBe(7);
    expect(w.credit(mv('1')).walletVersion).toBe(8);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e', walletId: 'w', transactionId: 't', walletVersion: 2, createdAt: at,
    money: m('10'), balanceBefore: m('100'), balanceAfter: m('90'), direction: LedgerDirection.Debit,
  };

  test('create valida a aritmética; isBalanced', () => {
    const e = WalletLedgerEntry.create(base);
    expect(e.isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: m('91') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, money: Money.zero('BRL'), balanceAfter: m('100') })).toThrow(InvalidLedgerEntryError);
  });

  test('é imutável por estrutura: sem setters; campos são somente leitura em runtime', () => {
    const e = WalletLedgerEntry.create(base);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(e));
    expect(proto.filter((n) => /^(set|mark|update|change)/i.test(n))).toHaveLength(0);
    expect(WalletLedgerEntry.rehydrate({ ...base, balanceAfter: m('1') }).isBalanced()).toBe(false); // rehydrate não revalida
  });
});
