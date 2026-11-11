/**
 * Taxonomia estável e legível por máquina de motivos de rejeição/falha (ver ARCHITECTURE.md §6).
 * Os valores são contrato com os provedores: nunca renomear, só acrescentar.
 */
export const FailureCode = {
  // ---- REJECTED: violação de regra de negócio
  InsufficientFunds: 'INSUFFICIENT_FUNDS', // BET sem saldo
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS', // ROLLBACK que debitaria além do saldo
  WalletNotFound: 'WALLET_NOT_FOUND',
  PlayerMismatch: 'PLAYER_MISMATCH', // walletId não pertence ao playerId informado
  CurrencyMismatch: 'CURRENCY_MISMATCH', // moeda da operação ≠ moeda da wallet
  ReferenceNotFound: 'REFERENCE_NOT_FOUND', // referência nunca chegou (limite do PENDING_REFERENCE)
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED', // referência rejeitada/falha, ou não resolvida a tempo
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND', // ex.: REFUND referenciando WIN
  ReferenceWalletMismatch: 'REFERENCE_WALLET_MISMATCH',
  ReferencePlayerMismatch: 'REFERENCE_PLAYER_MISMATCH',
  ReferenceCurrencyMismatch: 'REFERENCE_CURRENCY_MISMATCH',
  ReferenceRoundMismatch: 'REFERENCE_ROUND_MISMATCH',
  ReferenceAmountMismatch: 'REFERENCE_AMOUNT_MISMATCH', // reversão parcial fora de escopo
  AlreadyReversed: 'ALREADY_REVERSED', // referência já revertida (REFUND/ROLLBACK processado)
  // ---- FAILED: erro permanente de infraestrutura (auditável)
  ProcessingExhausted: 'PROCESSING_EXHAUSTED', // tentativas esgotadas com erro técnico
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/** O que o provedor deve fazer com cada código. */
export type ProviderAdvice =
  | 'FIX_PAYLOAD' // corrija os dados e envie como NOVA transação (novo externalTransactionId)
  | 'WAIT_AND_RESUBMIT' // a condição pode mudar (ex.: saldo); reenvie como NOVA transação depois
  | 'GIVE_UP' // não adianta reenviar
  | 'CONTACT_SUPPORT'; // falha interna; reenvio automático não resolve

export const FAILURE_ADVICE: Readonly<Record<FailureCode, ProviderAdvice>> = {
  INSUFFICIENT_FUNDS: 'WAIT_AND_RESUBMIT',
  REVERSAL_INSUFFICIENT_FUNDS: 'WAIT_AND_RESUBMIT',
  WALLET_NOT_FOUND: 'FIX_PAYLOAD',
  PLAYER_MISMATCH: 'FIX_PAYLOAD',
  CURRENCY_MISMATCH: 'FIX_PAYLOAD',
  REFERENCE_NOT_FOUND: 'WAIT_AND_RESUBMIT',
  REFERENCE_NOT_PROCESSED: 'GIVE_UP',
  INVALID_REFERENCE_KIND: 'FIX_PAYLOAD',
  REFERENCE_WALLET_MISMATCH: 'FIX_PAYLOAD',
  REFERENCE_PLAYER_MISMATCH: 'FIX_PAYLOAD',
  REFERENCE_CURRENCY_MISMATCH: 'FIX_PAYLOAD',
  REFERENCE_ROUND_MISMATCH: 'FIX_PAYLOAD',
  REFERENCE_AMOUNT_MISMATCH: 'FIX_PAYLOAD',
  ALREADY_REVERSED: 'GIVE_UP',
  PROCESSING_EXHAUSTED: 'CONTACT_SUPPORT',
};
