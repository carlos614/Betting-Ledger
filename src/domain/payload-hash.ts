import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from './money';

/** Campos de negócio que entram no hash. Header Idempotency-Key, messageId e occurredAt NÃO entram. */
export interface HashablePayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * Algoritmo (documentado em ARCHITECTURE.md §3):
 *  1. projeta SÓ os campos de negócio acima;
 *  2. normaliza o valor (Money.from → "25.00"), para "25" e "25.00" terem o mesmo hash;
 *  3. omite campos `undefined`;
 *  4. serializa como JSON canônico (chaves ordenadas recursivamente, sem espaços);
 *  5. SHA-256 em hexadecimal.
 */
export function computePayloadHash(p: HashablePayload): string {
  const projected: Record<string, unknown> = {
    providerId: p.providerId,
    externalTransactionId: p.externalTransactionId,
    playerId: p.playerId,
    walletId: p.walletId,
    roundId: p.roundId,
    gameId: p.gameId,
    kind: p.kind,
    money: Money.from(p.money).toJSON(),
    referenceExternalTransactionId: p.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(projected)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
