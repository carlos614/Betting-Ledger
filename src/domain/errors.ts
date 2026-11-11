/** Erros de domínio: violações de invariantes/regras. Nunca dependem de framework. */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

export class MoneyOverflowError extends DomainError {
  readonly code = 'MONEY_OVERFLOW';
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
}

/** Tentativa de transicionar uma transação terminal: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class InvalidOutboxStateError extends DomainError {
  readonly code = 'INVALID_OUTBOX_STATE';
}

// ---------------------------------------------------------------- erros de aplicação

/** Mesma chave de idempotência (ou mesmo id externo) com payload diferente. NÃO é replay. */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(
    message: string,
    readonly existingTransactionId?: string,
  ) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(playerId: string, currency: string) {
    super(`wallet already exists for player ${playerId} in ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** Payload/mensagem inválido: permanente (HTTP 400; SQS → DLQ). Nunca adianta repetir igual. */
export class InvalidPayloadError extends Error {
  readonly code = 'INVALID_PAYLOAD';
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}
