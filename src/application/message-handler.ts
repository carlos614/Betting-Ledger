import { FailureCode } from '../domain/failure-codes';
import { classifyError } from './error-classification';
import { logEvent } from './log';
import type { MetricsService } from './metrics';
import { WagerMessageSchema, parseOrThrow } from './validation';
import type { SubmitCommand, TransactionResult } from './wager-processor';

/** O que o consumidor deve fazer com a mensagem. */
export type Decision =
  | { action: 'ack'; result: TransactionResult } // processada, rejeitada por negócio, pendente ou duplicata: confirmar
  | { action: 'dlq'; reason: string } // erro permanente: DLQ (sem retry inútil)
  | { action: 'retry'; delaySeconds: number; reason: string }; // erro transitório: devolver com backoff

export interface MessageHandlerOptions {
  consumerName: string;
  /** Recebimentos antes de desistir (FAILED + DLQ). Deve ser MENOR que o maxReceiveCount do redrive do SQS. */
  maxAttempts: number;
}

/** Subconjunto do WagerProcessor que o handler usa (facilita simular falhas nos testes). */
export interface TransactionExecutor {
  execute(cmd: SubmitCommand): Promise<TransactionResult>;
  recordFailure(cmd: SubmitCommand, code?: FailureCode): Promise<void>;
}

/**
 * Lógica de decisão do consumidor, sem nenhum I/O de SQS (testável). Reutiliza o MESMO caso de uso da
 * entrada HTTP. O ack só deve ser feito DEPOIS de este método devolver `ack` — e isso só acontece
 * depois do COMMIT (execute só resolve após a transação confirmar).
 *
 *  erro de negócio  → vira REJECTED (terminal, registrada) dentro do execute → `ack`
 *  erro transitório → `retry` com backoff exponencial (visibility timeout); após maxAttempts:
 *                     grava FAILED (terminal, auditável) e manda à DLQ
 *  erro permanente  → `dlq` (JSON/schema inválido, conflito de idempotência)
 */
export class WagerMessageHandler {
  constructor(
    private readonly processor: TransactionExecutor,
    private readonly metrics: MetricsService,
    private readonly opts: MessageHandlerOptions,
  ) {}

  async handle(body: string, receiveCount: number): Promise<Decision> {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return this.dlq('INVALID_JSON', undefined);
    }

    let cmd: SubmitCommand;
    try {
      const msg = parseOrThrow(WagerMessageSchema, raw, 'message');
      cmd = {
        ...msg.data,
        correlationId: msg.messageId,
        source: { type: 'sqs', consumerName: this.opts.consumerName, messageId: msg.messageId },
      };
    } catch (err) {
      return this.dlq('INVALID_MESSAGE', (err as Error).message);
    }

    try {
      return { action: 'ack', result: await this.processor.execute(cmd) };
    } catch (err) {
      if (classifyError(err) === 'PERMANENT') {
        return this.dlq((err as { code?: string }).code ?? 'PERMANENT_ERROR', (err as Error).message, cmd);
      }
      return this.transient(err, cmd, receiveCount);
    }
  }

  private async transient(err: unknown, cmd: SubmitCommand, receiveCount: number): Promise<Decision> {
    if (receiveCount >= this.opts.maxAttempts) {
      try {
        await this.processor.recordFailure(cmd, FailureCode.ProcessingExhausted);
        return this.dlq(FailureCode.ProcessingExhausted, (err as Error).message, cmd);
      } catch (recordErr) {
        // não conseguiu nem registrar a falha (banco ainda fora): devolve; o redrive do SQS é a rede de segurança
        logEvent('error', 'could not record FAILED; returning message to queue', { messageId: cmd.correlationId, error: (recordErr as Error).message });
      }
    }
    this.metrics.inc('wager_retries_total', { reason: 'sqs_transient' });
    logEvent('warn', 'transient failure; message will be retried', {
      correlationId: cmd.correlationId, messageId: cmd.correlationId, providerId: cmd.providerId, receiveCount, error: (err as Error).message,
    });
    return { action: 'retry', delaySeconds: Math.min(2 ** receiveCount, 120), reason: (err as Error).message };
  }

  private dlq(reason: string, detail: string | undefined, cmd?: SubmitCommand): Decision {
    this.metrics.inc('wager_dlq_messages_total', { reason });
    logEvent('error', 'message sent to DLQ', {
      reason, detail, ...(cmd ? { correlationId: cmd.correlationId, messageId: cmd.correlationId, providerId: cmd.providerId, walletId: cmd.walletId } : {}),
    });
    return { action: 'dlq', reason };
  }
}
