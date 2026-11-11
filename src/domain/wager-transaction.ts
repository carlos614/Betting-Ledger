import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import type { FailureCode } from './failure-codes';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

/**
 * Transições válidas (qualquer outra lança InvalidTransactionStateError):
 *
 *   PENDING            ──▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE  ──▶ PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED: terminais
 */
const TERMINAL = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt?: Date;
}

export interface WagerTransactionState extends Required<Omit<CreateWagerTransactionProps, 'referenceExternalTransactionId'>> {
  referenceExternalTransactionId: string | undefined;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  attempts: number;
  nextAttemptAt: Date | undefined;
  /** Saldo da wallet observado quando a transação terminou (usado para replays fiéis). */
  observedBalance: Money | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _attempts: number = 0,
    private _nextAttemptAt?: Date,
    private _observedBalance?: Money,
  ) {}

  /**
   * Nasce em PENDING. Valida a exigência de referência por kind.
   * OPENING é interno: só pode ser criado com `{ internal: true }` (a API e a fila não passam por aqui assim).
   */
  static create(props: CreateWagerTransactionProps, options: { internal?: boolean } = {}): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && !options.internal) {
      throw new InvalidTransactionError('OPENING is internal and cannot be submitted');
    }
    if (!props.money.isPositive()) throw new InvalidTransactionError('transaction amount must be positive');
    for (const [name, value] of Object.entries({
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    })) {
      if (!value) throw new InvalidTransactionError(`${name} is required`);
    }
    const needsRef = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsRef && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Opening && props.referenceExternalTransactionId) {
      throw new InvalidTransactionError('OPENING cannot reference another transaction');
    }
    if (props.kind === WagerTransactionKind.Bet && props.referenceExternalTransactionId) {
      throw new InvalidTransactionError('BET cannot reference another transaction');
    }
    return WagerTransaction.build({
      ...props,
      createdAt: props.createdAt ?? new Date(),
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      attempts: 0,
      nextAttemptAt: undefined,
      observedBalance: undefined,
    });
  }

  /** Reconstrói estado já persistido; não revalida regras de transição. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return WagerTransaction.build(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal/incompatível)

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  /** PENDING → PENDING_REFERENCE; agenda a primeira reavaliação. */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal('markPendingReference');
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`cannot move ${this._status} to PENDING_REFERENCE`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts = 0;
    this._nextAttemptAt = nextAttemptAt;
  }

  /** Continua PENDING_REFERENCE: contabiliza a tentativa e agenda a próxima (backoff calculado fora). */
  rescheduleReference(nextAttemptAt: Date): void {
    this.assertNotTerminal('rescheduleReference');
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`cannot reschedule a ${this._status} transaction`);
    }
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, at: Date = new Date(), observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** false para LOSS */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. ROLLBACK é o inverso da referência:
   * BET → crédito, WIN → débito, REFUND → débito.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS does not move the balance');
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionError('ROLLBACK needs its reference to define the direction');
        return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(op: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${op} on a terminal transaction (${this._status})`);
    }
  }

  private static build(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.attempts,
      s.nextAttemptAt,
      s.observedBalance,
    );
  }
}
