import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

describe('Money', () => {
  test('aritmética decimal exata (0.10 + 0.20 == 0.30)', () => {
    expect(m('0.10').add(m('0.20')).equals(m('0.30'))).toBe(true);
    expect(m('0.10').add(m('0.20')).toJSON().amount).toBe('0.30');
  });

  test('serialização sempre com escala fixa de 2 casas', () => {
    expect(m('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(m('25.5').toJSON().amount).toBe('25.50');
    expect(m('25.55').toJSON().amount).toBe('25.55');
    expect(m('0').toJSON().amount).toBe('0.00');
    expect(m('25.00').toString()).toBe('25.00 BRL');
    expect(JSON.stringify({ money: m('1') })).toBe('{"money":{"amount":"1.00","currency":"BRL"}}');
  });

  test('imutabilidade: operações devolvem novas instâncias', () => {
    const a = m('10');
    const b = a.add(m('5'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
    expect(a.negate().toJSON().amount).toBe('-10.00');
    expect(a.toJSON().amount).toBe('10.00');
  });

  test('subtract / negate / sinais / zero', () => {
    const r = m('10').subtract(m('25.50'));
    expect(r.isNegative()).toBe(true);
    expect(r.toJSON().amount).toBe('-15.50');
    expect(r.negate().equals(m('15.50'))).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(m('0.01').isPositive()).toBe(true);
  });

  test('comparação e igualdade', () => {
    expect(m('1').isLessThan(m('2'))).toBe(true);
    expect(m('2').isLessThan(m('2'))).toBe(false);
    expect(m('2.0').equals(m('2.00'))).toBe(true);
    expect(m('2').equals(m('2.01'))).toBe(false);
  });

  test('conflito de moeda lança erro de domínio (add, subtract, isLessThan)', () => {
    const brl = m('1', 'BRL');
    const usd = m('1', 'USD');
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  test('rejeita entradas inválidas', () => {
    const bad = ['', ' ', 'NaN', 'Infinity', '-Infinity', '1e3', '1E3', '0x10', '1.234', '25.001', '-1', '-0.01', '+1', '.5', '1.', '1,5', 'abc', ' 1'];
    for (const amount of bad) expect(() => m(amount)).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: 1.5 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: NaN as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => m('1', 'brl')).toThrow(InvalidMoneyError);
    expect(() => m('1', 'BRLX')).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
  });

  test('"arredondamento": mais de 2 casas é rejeitado, nunca arredondado silenciosamente', () => {
    expect(() => m('10.005')).toThrow(InvalidMoneyError);
  });

  test('overflow acima de NUMERIC(20,2)', () => {
    const big = m('999999999999999999.99');
    expect(() => big.add(m('0.01'))).toThrow(MoneyOverflowError);
  });

  test('valores acima de 2^53 continuam exatos', () => {
    expect(m('90071992547409.93').add(m('0.01')).toJSON().amount).toBe('90071992547409.94');
    expect(m('9007199254740993.01').add(m('0.01')).toJSON().amount).toBe('9007199254740993.02');
  });

  test('fromSigned (diagnóstico) aceita sinal; from não', () => {
    expect(Money.fromSigned({ amount: '-5.5', currency: 'BRL' }).toJSON().amount).toBe('-5.50');
    expect(() => m('-5.5')).toThrow(InvalidMoneyError);
  });
});
