import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type Message,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { Decision, WagerMessageHandler } from '../../application/message-handler';
import { logEvent } from '../../application/log';
import type { MetricsService } from '../../application/metrics';
import { config } from '../../config';
import type { SqsService } from './sqs.service';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Consumidor de `wager-transactions.fifo` (at-least-once).
 *
 *  - ack (DeleteMessage) SOMENTE depois do COMMIT: o handler só devolve `ack` após o caso de uso resolver;
 *  - mensagens do mesmo MessageGroupId (= walletId) são processadas em ordem e em sequência; grupos
 *    diferentes em paralelo. Isso é otimização: a correção NÃO depende da ordem (o banco garante);
 *  - retry transitório: ChangeMessageVisibility com backoff; DLQ após o limite ou erro permanente;
 *  - SIGTERM: para de receber (aborta o long poll), conclui as mensagens EM ANDAMENTO e devolve as não
 *    iniciadas à fila com visibilidade 0, para outra instância pegar na hora.
 */
export class WagerConsumer {
  private stopping = false;
  private loop: Promise<void> | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly sqs: SqsService,
    private readonly handler: WagerMessageHandler,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!config.consumer.enabled) {
      logEvent('warn', 'SQS consumer disabled (CONSUMER_ENABLED=false)');
      return;
    }
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.abort.abort(); // interrompe o long poll; o lote em andamento termina normalmente
    await this.loop;
  }

  private async run(): Promise<void> {
    let queueUrl: string;
    let dlqUrl: string;
    while (!this.stopping) {
      try {
        queueUrl = await this.sqs.queueUrl(config.queues.transactions);
        dlqUrl = await this.sqs.queueUrl(config.queues.transactionsDlq);
        break;
      } catch (err) {
        logEvent('warn', 'waiting for SQS queues', { error: (err as Error).message });
        await sleep(2000); // LocalStack pode subir depois da aplicação
      }
    }
    if (this.stopping) return;
    logEvent('info', 'SQS consumer started', { queue: config.queues.transactions });

    while (!this.stopping) {
      try {
        const { Messages = [] } = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl!,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 10,
            VisibilityTimeout: 60,
            MessageSystemAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        await this.processBatch(Messages, queueUrl!, dlqUrl!);
      } catch (err) {
        if (this.stopping) break;
        // SQS indisponível: espera e tenta de novo; nenhuma mensagem se perde (continua na fila)
        logEvent('error', 'receive failed', { error: (err as Error).message });
        await sleep(2000);
      }
    }
    logEvent('info', 'SQS consumer stopped');
  }

  private async processBatch(messages: Message[], queueUrl: string, dlqUrl: string): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const g = m.Attributes?.MessageGroupId ?? m.MessageId ?? randomUUID();
      groups.set(g, [...(groups.get(g) ?? []), m]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group, queueUrl, dlqUrl)));
  }

  private async processGroup(group: Message[], queueUrl: string, dlqUrl: string): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      const message = group[i] as Message;
      if (this.stopping) {
        await this.release(queueUrl, group.slice(i)); // não iniciadas: voltam já para a fila
        return;
      }
      const decision = await this.handler.handle(message.Body ?? '', Number(message.Attributes?.ApproximateReceiveCount ?? '1'));
      const ok = await this.settle(decision, message, queueUrl, dlqUrl);
      if (decision.action === 'retry' || !ok) {
        await this.release(queueUrl, group.slice(i + 1)); // preserva a ordem do grupo: o resto espera
        return;
      }
    }
  }

  /** Aplica a decisão. Devolve false se não conseguiu confirmar (a mensagem voltará e será deduplicada). */
  private async settle(decision: Decision, message: Message, queueUrl: string, dlqUrl: string): Promise<boolean> {
    try {
      if (decision.action === 'ack') {
        await this.sqs.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
      } else if (decision.action === 'dlq') {
        await this.sqs.client.send(
          new SendMessageCommand({
            QueueUrl: dlqUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
            MessageDeduplicationId: randomUUID(),
            MessageAttributes: { failureReason: { DataType: 'String', StringValue: decision.reason } },
          }),
        );
        await this.sqs.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
      } else {
        await this.sqs.client.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: decision.delaySeconds }),
        );
      }
      return true;
    } catch (err) {
      // Ex.: crash/erro DEPOIS do commit e ANTES do ack. A mensagem reaparece e vira duplicata (inbox).
      this.metrics.inc('wager_retries_total', { reason: 'sqs_ack_failed' });
      logEvent('error', 'could not settle message', { messageId: message.MessageId, action: decision.action, error: (err as Error).message });
      return false;
    }
  }

  /** Devolve mensagens à fila imediatamente (visibilidade 0). */
  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    await Promise.all(
      messages.map((m) =>
        this.sqs.client
          .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: 0 }))
          .catch(() => undefined),
      ),
    );
  }
}
