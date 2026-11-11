import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { ApiExceptionFilter } from './http/exception-filter';
import { JsonLogger } from './infra/logging/json-logger';

const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
app.useGlobalFilters(new ApiExceptionFilter());
app.enableShutdownHooks(); // SIGTERM: Nest chama onApplicationShutdown nos workers
await app.listen(config.port, '0.0.0.0');
