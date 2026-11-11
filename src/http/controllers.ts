import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Header, Headers, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { WageringApi, type ApiResponse } from './api';
import { AuthGuard } from './auth';

/**
 * Adaptadores finos: toda a lógica HTTP (validação, status, erros) está em WageringApi,
 * que é independente de framework e testada contra PostgreSQL real.
 */
interface ResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

function send(res: ResponseLike, r: ApiResponse): unknown {
  res.status(r.status);
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  return r.body;
}

/** Aceita o x-correlation-id do cliente (se for seguro) ou gera um novo. */
const correlationIdOf = (header: string | undefined): string =>
  header && /^[A-Za-z0-9._:-]{1,128}$/.test(header) ? header : randomUUID();

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(@Inject(WageringApi) private readonly api: WageringApi) {}

  @Post()
  async create(@Body() body: unknown, @Headers('x-correlation-id') cid: string | undefined, @Res({ passthrough: true }) res: ResponseLike) {
    return send(res, await this.api.createWallet(body, correlationIdOf(cid)));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string, @Headers('x-correlation-id') cid: string | undefined, @Res({ passthrough: true }) res: ResponseLike) {
    return send(res, await this.api.getWallet(walletId, correlationIdOf(cid)));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Headers('x-correlation-id') cid: string | undefined,
    @Res({ passthrough: true }) res: ResponseLike,
  ) {
    return send(res, await this.api.getLedger(walletId, { cursor, limit }, correlationIdOf(cid)));
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string, @Headers('x-correlation-id') cid: string | undefined, @Res({ passthrough: true }) res: ResponseLike) {
    return send(res, await this.api.reconcile(walletId, correlationIdOf(cid)));
  }
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(@Inject(WageringApi) private readonly api: WageringApi) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') cid: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ResponseLike,
  ) {
    return send(res, await this.api.submitTransaction(idempotencyKey, body, correlationIdOf(cid)));
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') id: string, @Headers('x-correlation-id') cid: string | undefined, @Res({ passthrough: true }) res: ResponseLike) {
    return send(res, await this.api.getTransaction(id, correlationIdOf(cid)));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
    @Headers('x-correlation-id') cid: string | undefined,
    @Res({ passthrough: true }) res: ResponseLike,
  ) {
    return send(res, await this.api.getProviderTransaction(providerId, externalId, correlationIdOf(cid)));
  }
}

/** Saúde e métricas: SEM autenticação (escopo da seção 2). */
@Controller()
export class HealthController {
  constructor(@Inject(WageringApi) private readonly api: WageringApi) {}

  @Get('health/live')
  live(@Res({ passthrough: true }) res: ResponseLike) {
    return send(res, this.api.live());
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: ResponseLike) {
    return send(res, await this.api.ready());
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics() {
    return this.api.metricsText();
  }
}
