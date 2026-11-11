import type { OutboxPublisher } from '../application/outbox-publisher';
import { logEvent } from '../application/log';
import type { WagerProcessor } from '../application/wager-processor';
import { config } from '../config';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Laço de polling com parada graciosa (conclui o ciclo corrente antes de encerrar). */
abstract class PollingWorker {
  private stopping = false;
  private loop: Promise<void> | null = null;

  protected abstract readonly name: string;
  protected abstract readonly enabled: boolean;
  protected abstract readonly intervalMs: number;
  /** Executa um ciclo; devolve quanto trabalho fez (0 ⇒ dorme `intervalMs`). */
  protected abstract tick(): Promise<number>;

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      logEvent('warn', `${this.name} disabled`);
      return;
    }
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let worked = 0;
      try {
        worked = await this.tick();
      } catch (err) {
        logEvent('error', `${this.name} cycle failed`, { error: (err as Error).message });
        await sleep(2000);
        continue;
      }
      if (worked === 0) await sleep(this.intervalMs);
    }
  }
}

/** Publica a outbox. Pode rodar em todas as instâncias ao mesmo tempo (SKIP LOCKED). */
export class OutboxWorker extends PollingWorker {
  protected readonly name = 'outbox-publisher';
  protected readonly enabled = config.outbox.enabled;
  protected readonly intervalMs = config.outbox.pollIntervalMs;
  private lastLag = 0;

  constructor(private readonly publisher: OutboxPublisher) {
    super();
  }

  protected async tick(): Promise<number> {
    const n = await this.publisher.drainOnce(config.outbox.batchSize);
    if (Date.now() - this.lastLag > 5_000) {
      this.lastLag = Date.now();
      await this.publisher.updateLagMetric();
    }
    return n;
  }
}

/** Reavalia transações PENDING_REFERENCE vencidas (backoff exponencial / TTL). Seguro com N instâncias. */
export class PendingReferenceWorker extends PollingWorker {
  protected readonly name = 'pending-reference-worker';
  protected readonly enabled = config.pendingWorker.enabled;
  protected readonly intervalMs = config.pendingWorker.pollIntervalMs;

  constructor(private readonly processor: WagerProcessor) {
    super();
  }

  protected tick(): Promise<number> {
    return this.processor.processDuePending();
  }
}
