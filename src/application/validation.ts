import { z } from 'zod';
import { InvalidPayloadError } from '../domain/errors';

const money = z
  .object({
    amount: z
      .string()
      .regex(/^\d{1,18}(\.\d{1,2})?$/, 'amount must be a non-negative decimal string with up to 2 places')
      .refine((v) => /[1-9]/.test(v), 'amount must be greater than zero'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 code'),
  })
  .strict();

const externalId = z.string().min(1).max(128).regex(/^\S+$/, 'must not contain whitespace');

/** A identidade do provedor da mensagem passa pela mesma validação, venha de HTTP ou da fila. */
export const providerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'invalid providerId');

/** Corpo comum de HTTP e SQS. OPENING não é aceito: é interno. */
export const TransactionBodySchema = z
  .object({
    providerId,
    externalTransactionId: externalId,
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: externalId,
    gameId: externalId,
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money,
    referenceExternalTransactionId: externalId.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.kind === 'REFUND' || v.kind === 'ROLLBACK') && !v.referenceExternalTransactionId) {
      ctx.addIssue({ code: 'custom', path: ['referenceExternalTransactionId'], message: `${v.kind} requires referenceExternalTransactionId` });
    }
    if (v.kind === 'BET' && v.referenceExternalTransactionId) {
      ctx.addIssue({ code: 'custom', path: ['referenceExternalTransactionId'], message: 'BET cannot reference another transaction' });
    }
  });

export type TransactionBody = z.infer<typeof TransactionBodySchema>;

export const IdempotencyKeySchema = z.string().min(1).max(255).regex(/^\S+$/, 'Idempotency-Key must not contain whitespace');

/** Mensagem do SQS (seção 10). */
export const WagerMessageSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string().datetime({ offset: true }),
    data: z
      .object({
        providerId,
        externalTransactionId: externalId,
        idempotencyKey: IdempotencyKeySchema,
        playerId: z.string().uuid(),
        walletId: z.string().uuid(),
        roundId: externalId,
        gameId: externalId,
        kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
        money,
        referenceExternalTransactionId: externalId.optional(),
      })
      .strict(),
  })
  .strict();

export type WagerMessage = z.infer<typeof WagerMessageSchema>;

export const CreateWalletSchema = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: z
      .object({
        amount: z.string().regex(/^\d{1,18}(\.\d{1,2})?$/, 'amount must be a non-negative decimal string with up to 2 places'),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
  })
  .strict();

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new InvalidPayloadError(
      `invalid ${what}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
