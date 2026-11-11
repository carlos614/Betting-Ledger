const env = process.env;

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v.toLowerCase() === 'true');
const int = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  port: int(env.PORT, 3000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5433/ledger',
  aws: {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.SQS_ENDPOINT, // LocalStack / MiniStack
  },
  queues: {
    transactions: env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo',
    transactionsDlq: env.SQS_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo',
    events: env.SQS_EVENTS_QUEUE ?? 'wager-events',
  },
  processor: {
    pendingMaxAttempts: int(env.PENDING_MAX_ATTEMPTS, 8),
    pendingBaseDelaySeconds: int(env.PENDING_BASE_DELAY_SECONDS, 5),
    pendingMaxDelaySeconds: int(env.PENDING_MAX_DELAY_SECONDS, 300),
    pendingTtlSeconds: int(env.PENDING_TTL_SECONDS, 1800),
    lockTimeoutMs: int(env.LOCK_TIMEOUT_MS, 10_000),
  },
  consumer: {
    enabled: bool(env.CONSUMER_ENABLED, true),
    maxAttempts: int(env.CONSUMER_MAX_ATTEMPTS, 5),
  },
  outbox: {
    enabled: bool(env.OUTBOX_PUBLISHER_ENABLED, true),
    pollIntervalMs: int(env.OUTBOX_POLL_INTERVAL_MS, 500),
    batchSize: int(env.OUTBOX_BATCH_SIZE, 50),
  },
  pendingWorker: {
    enabled: bool(env.PENDING_WORKER_ENABLED, true),
    pollIntervalMs: int(env.PENDING_WORKER_INTERVAL_MS, 2000),
  },
} as const;
