import { OutboxMessage } from '../domain/outbox-message';
import type { TransactionRunner } from '../infra/persistence/ports';
import { logEvent } from './log';
import type { MetricsService } from './metrics';
import { toDate } from './repositories';

export interface OutboundEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  /** Envelope JSON serializado. */
  body: string;
}

/** Destino da publicação (SQS em produção; um array nos testes). */
export interface EventSender {
  send(event: OutboundEvent): Promise<void>;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date | string;
  attempts: number | string;
  next_attempt_at: Date | string | null;
}

/**
 * Publisher da Transactional Outbox. Funciona com N instâncias concorrentes:
 *  - `FOR UPDATE SKIP LOCKED` reparte as linhas entre os publishers (sem espera, sem dupla publicação normal);
 *  - envia ANTES de marcar `published_at`, ambos na mesma transação: se o processo morrer entre os dois,
 *    o rollback devolve a linha e OUTRA instância a publica de novo ⇒ at-least-once; os consumidores
 *    deduplicam por `eventId` (= id da linha, estável entre reenvios);
 *  - falha de publicação ⇒ `attempts++`, `next_attempt_at` com backoff exponencial e `last_error`;
 *  - nada é publicado antes do COMMIT da transação financeira, pois a linha só existe depois dele.
 */
export class OutboxPublisher {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly sender: EventSender,
    private readonly metrics: MetricsService,
  ) {}

  /** Publica um lote de eventos devidos. Devolve quantos foram publicados. */
  async drainOnce(batchSize = 50, now: Date = new Date()): Promise<number> {
    return this.runner.transactional(async (db) => {
      const rows = await db.execute<OutboxRow>(
        `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
           from outbox_messages
          where published_at is null and (next_attempt_at is null or next_attempt_at <= now())
          order by occurred_at, id limit ? for update skip locked`,
        [batchSize],
      );
      let published = 0;
      for (const row of rows) {
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : (row.payload as Record<string, unknown>),
          occurredAt: toDate(row.occurred_at),
          attempts: Number(row.attempts),
          nextAttemptAt: row.next_attempt_at ? toDate(row.next_attempt_at) : undefined,
        });
        try {
          await this.sender.send({
            eventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            body: JSON.stringify(message.payload),
          });
        } catch (err) {
          message.scheduleRetry(now);
          await db.execute(`update outbox_messages set attempts = ?, next_attempt_at = ?::timestamptz, last_error = ? where id = ?`, [
            message.attempts, message.nextAttemptAt?.toISOString() ?? null, String((err as Error).message).slice(0, 500), message.id,
          ]);
          this.metrics.inc('wager_retries_total', { reason: 'outbox_publish' });
          logEvent('warn', 'outbox publish failed; scheduled retry', { eventId: message.id, attempts: message.attempts, error: (err as Error).message });
          break; // destino provavelmente indisponível: não insiste neste ciclo
        }
        message.markPublished(now);
        await db.execute(`update outbox_messages set published_at = ?::timestamptz, attempts = ?, last_error = null where id = ?`, [
          now.toISOString(), message.attempts, message.id,
        ]);
        published += 1;
      }
      return published;
    });
  }

  /** Atualiza `wager_outbox_lag_seconds` (idade do evento pendente mais antigo). */
  async updateLagMetric(): Promise<number> {
    const rows = await this.runner.transactional((db) =>
      db.execute<{ lag: number | string | null }>(
        `select coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as lag
           from outbox_messages where published_at is null`,
      ),
    );
    const lag = Math.max(0, Number(rows[0]?.lag ?? 0));
    this.metrics.setGauge('wager_outbox_lag_seconds', lag);
    return lag;
  }
}
