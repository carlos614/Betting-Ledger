import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerMessageHandler } from './application/message-handler';
import { MetricsService } from './application/metrics';
import { OutboxPublisher } from './application/outbox-publisher';
import { TransactionQueries } from './application/transaction-queries';
import { WagerProcessor } from './application/wager-processor';
import { WalletService } from './application/wallet-service';
import { config } from './config';
import { WageringApi } from './http/api';
import { AuthGuard, IDENTITY_PROVIDER, NoopIdentityProvider } from './http/auth';
import { HealthController, WageringController, WalletsController } from './http/controllers';
import { MikroOrmTransactionRunner } from './infra/persistence/mikro-orm-runner';
import { buildOrmConfig } from './infra/persistence/orm.config';
import { TRANSACTION_RUNNER } from './infra/persistence/tokens';
import { UiController } from './ui/ui.controller';
import { SqsEventSender } from './infra/sqs/sqs-event-sender';
import { SqsService } from './infra/sqs/sqs.service';
import { WagerConsumer } from './infra/sqs/wager-consumer';
import { OutboxWorker, PendingReferenceWorker } from './infra/workers';
import type { TransactionRunner } from './infra/persistence/ports';

@Module({
  imports: [MikroOrmModule.forRoot(buildOrmConfig())],
  controllers: [WalletsController, WageringController, HealthController, UiController],
  providers: [
    SqsService,
    { provide: MetricsService, useFactory: () => new MetricsService() },
    { provide: TRANSACTION_RUNNER, useFactory: (orm: MikroORM) => new MikroOrmTransactionRunner(orm), inject: [MikroORM] },
    {
      provide: WagerProcessor,
      useFactory: (runner: TransactionRunner, metrics: MetricsService) => new WagerProcessor(runner, metrics, { ...config.processor }),
      inject: [TRANSACTION_RUNNER, MetricsService],
    },
    {
      provide: WalletService,
      useFactory: (runner: TransactionRunner, metrics: MetricsService) => new WalletService(runner, metrics),
      inject: [TRANSACTION_RUNNER, MetricsService],
    },
    { provide: TransactionQueries, useFactory: (runner: TransactionRunner) => new TransactionQueries(runner), inject: [TRANSACTION_RUNNER] },
    {
      provide: WageringApi,
      useFactory: (
        processor: WagerProcessor, wallets: WalletService, queries: TransactionQueries, metrics: MetricsService,
        runner: TransactionRunner, sqs: SqsService,
      ) =>
        new WageringApi(processor, wallets, queries, metrics, [
          { name: 'postgres', check: async () => void (await runner.transactional((db) => db.execute('select 1'))) },
          { name: 'sqs', check: () => sqs.ping(config.queues.transactions) },
        ]),
      inject: [WagerProcessor, WalletService, TransactionQueries, MetricsService, TRANSACTION_RUNNER, SqsService],
    },
    {
      provide: WagerMessageHandler,
      useFactory: (processor: WagerProcessor, metrics: MetricsService) =>
        new WagerMessageHandler(processor, metrics, { consumerName: 'wager-transactions-consumer', maxAttempts: config.consumer.maxAttempts }),
      inject: [WagerProcessor, MetricsService],
    },
    { provide: WagerConsumer, useFactory: (sqs: SqsService, h: WagerMessageHandler, m: MetricsService) => new WagerConsumer(sqs, h, m), inject: [SqsService, WagerMessageHandler, MetricsService] },
    {
      provide: OutboxPublisher,
      useFactory: (runner: TransactionRunner, sqs: SqsService, metrics: MetricsService) => new OutboxPublisher(runner, new SqsEventSender(sqs), metrics),
      inject: [TRANSACTION_RUNNER, SqsService, MetricsService],
    },
    { provide: OutboxWorker, useFactory: (p: OutboxPublisher) => new OutboxWorker(p), inject: [OutboxPublisher] },
    { provide: PendingReferenceWorker, useFactory: (p: WagerProcessor) => new PendingReferenceWorker(p), inject: [WagerProcessor] },
    AuthGuard,
    // ponto de extensão: troque por um adapter OIDC (Keycloak/Zitadel) sem tocar nos controllers
    { provide: IDENTITY_PROVIDER, useClass: NoopIdentityProvider },
  ],
})
export class AppModule {}
