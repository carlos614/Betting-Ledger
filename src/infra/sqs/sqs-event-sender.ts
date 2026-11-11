import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { EventSender, OutboundEvent } from '../../application/outbox-publisher';
import { config } from '../../config';
import type { SqsService } from './sqs.service';

/** Publica os eventos da outbox na fila `wager-events`. `eventId` vai como atributo para deduplicação no consumidor. */
export class SqsEventSender implements EventSender {
  constructor(private readonly sqs: SqsService) {}

  async send(event: OutboundEvent): Promise<void> {
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: await this.sqs.queueUrl(config.queues.events),
        MessageBody: event.body,
        MessageAttributes: {
          eventId: { DataType: 'String', StringValue: event.eventId },
          eventType: { DataType: 'String', StringValue: event.eventType },
          aggregateId: { DataType: 'String', StringValue: event.aggregateId },
        },
      }),
    );
  }
}
