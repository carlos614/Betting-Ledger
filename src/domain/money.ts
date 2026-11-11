import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from './errors';

/** DTO — interface é adequada aqui */
export interface MoneyProps {
  amount: string; // string decimal, sempre com 2 casas ao serializar, ex.: "25.00"
  currency: string; // ISO-4217
}

/**
 * Value Object imutável. O valor é um inteiro `bigint` em centavos (escala fixa 2),
 * logo toda aritmética é exata: nenhum `number`/float toca em dinheiro. Espelha NUMERIC(20,2).
 */
const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
const MAX_UNITS = 10n ** 20n; // NUMERIC(20,2): 18 dígitos inteiros + 2 decimais
const UNSIGNED = /^(\d{1,18})(?:\.(\d{1,2}))?$/; // rejeita '', NaN, Infinity, 1e3, '.5', '1.', >2 casas, sinal
const SIGNED = /^(-)?(\d{1,18})(?:\.(\d{1,2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly units: bigint,
    public readonly currency: string,
  ) {}

  /** Entrada de contrato: valores negativos são inválidos. 0–2 casas decimais; saída sempre com 2. */
  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  /** Uso interno/diagnóstico (ex.: diferença da reconciliação). Aceita sinal. */
  static fromSigned(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofUnits(this.units + other.units, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofUnits(this.units - other.units, this.currency);
  }

  negate(): Money {
    return new Money(-this.units, this.currency);
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.units < other.units;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.units === other.units;
  }

  toJSON(): MoneyProps {
    return { amount: this.format(), currency: this.currency };
  }

  /** Forma decimal exata para o banco (NUMERIC(20,2)). */
  toDecimalString(): string {
    return this.format();
  }

  toString(): string {
    return `${this.format()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  private static parse(props: MoneyProps, allowNegative: boolean): Money {
    if (props === null || typeof props !== 'object') throw new InvalidMoneyError('money must be an object');
    if (typeof props.amount !== 'string') throw new InvalidMoneyError('amount must be a decimal string');
    if (typeof props.currency !== 'string' || !CURRENCY.test(props.currency)) {
      throw new InvalidMoneyError(`invalid currency: ${String(props.currency)}`);
    }
    const match = (allowNegative ? SIGNED : UNSIGNED).exec(props.amount);
    if (!match) throw new InvalidMoneyError(`invalid decimal amount: "${props.amount}"`);
    const negative = allowNegative && match[1] === '-';
    const whole = (allowNegative ? match[2] : match[1]) as string;
    const frac = (allowNegative ? match[3] : match[2]) ?? '';
    let units = BigInt(whole) * FACTOR + BigInt(frac.padEnd(SCALE, '0'));
    if (negative) units = -units;
    return new Money(units, props.currency);
  }

  private static ofUnits(units: bigint, currency: string): Money {
    const abs = units < 0n ? -units : units;
    if (abs >= MAX_UNITS) throw new MoneyOverflowError('amount exceeds NUMERIC(20,2)');
    return new Money(units, currency);
  }

  private format(): string {
    const negative = this.units < 0n;
    const abs = negative ? -this.units : this.units;
    const frac = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${abs / FACTOR}.${frac}`;
  }
}
