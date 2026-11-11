import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../../config';

/** Cliente SQS + resolução (com cache) das URLs das filas. Funciona com AWS, LocalStack e MiniStack. */
export class SqsService {
  readonly client = new SQSClient({
    region: config.aws.region,
    ...(config.aws.endpoint ? { endpoint: config.aws.endpoint } : {}),
  });
  private readonly urls = new Map<string, string>();

  async queueUrl(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`queue ${name} has no URL`);
    this.urls.set(name, QueueUrl);
    return QueueUrl;
  }

  /** Readiness: a fila principal existe e responde. */
  async ping(queueName: string): Promise<void> {
    const url = await this.queueUrl(queueName);
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  }
}
