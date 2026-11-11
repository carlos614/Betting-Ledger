import { InsufficientFundsError, InvalidMoneyError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

/**
 * Aggregate Root. Só deve ser mutado com a linha travada (SELECT … FOR UPDATE);
 * o banco ainda valida o resultado (CHECK balance >= 0, versão e razão no COMMIT).
 *
 * `version` começa em 1 e só incrementa quando o saldo muda. Cada movimentação devolve o
 * lançamento correspondente, de modo que saldo e razão nunca divergem na aplicação.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new InvalidMoneyError('initial balance cannot be negative');
    const at = props.at ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, at, at);
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(`balance ${this._balance} is less than ${movement.money}`);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(movement.money), movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(movement.money), movement);
  }

  private apply(direction: LedgerDirection, next: Money, m: WalletMovement): WalletLedgerEntry {
    const before = this._balance;
    const entry = WalletLedgerEntry.create({
      id: m.entryId,
      walletId: this.id,
      transactionId: m.transactionId,
      direction,
      money: m.money,
      balanceBefore: before,
      balanceAfter: next,
      walletVersion: this._version + 1,
      createdAt: m.at,
    });
    this._balance = next;
    this._version += 1;
    this._updatedAt = m.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new InvalidMoneyError('movement amount must be positive');
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new InvalidMoneyError(`wallet currency is ${this.currency}, got ${money.currency}`);
    }
  }
}
