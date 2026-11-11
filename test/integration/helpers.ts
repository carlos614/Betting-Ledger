process.env.LOG_SILENT = process.env.LOG_SILENT ?? 'true';

import { randomUUID } from 'node:crypto';
import { MetricsService } from '../../src/application/metrics';
import { TransactionQueries } from '../../src/application/transaction-queries';
import { WagerProcessor, DEFAULT_OPTIONS, type WagerProcessorOptions } from '../../src/application/wager-processor';
import { WalletService } from '../../src/application/wallet-service';
import { WageringApi, type ApiResponse } from '../../src/http/api';
import { BunSqlRunner, DATABASE_URL, ensureSchema } from './db';

export { DATABASE_URL };

export interface Stack {
  runner: BunSqlRunner;
  metrics: MetricsService;
  processor: WagerProcessor;
  wallets: WalletService;
  queries: TransactionQueries;
  api: WageringApi;
}

/** Uma "instância da aplicação": pool próprio de conexões + todos os serviços. */
export function buildStack(options: Partial<WagerProcessorOptions> = {}, runner: BunSqlRunner = new BunSqlRunner(DATABASE_URL as string)): Stack {
  const metrics = new MetricsService();
  const processor = new WagerProcessor(runner, metrics, { ...DEFAULT_OPTIONS, ...options });
  const wallets = new WalletService(runner, metrics);
  const queries = new TransactionQueries(runner);
  const api = new WageringApi(processor, wallets, queries, metrics, [
    { name: 'postgres', check: async () => void (await runner.query('select 1')) },
  ]);
  return { runner, metrics, processor, wallets, queries, api };
}

export async function setupSchema(): Promise<void> {
  const r = new BunSqlRunner(DATABASE_URL as string, 2);
  await ensureSchema(r);
  await r.close();
}

export interface TestWallet {
  id: string;
  playerId: string;
}

export async function createWallet(api: WageringApi, initial = '100.00', currency = 'BRL'): Promise<TestWallet> {
  const playerId = randomUUID();
  const res = await api.createWallet({ playerId, initialBalance: { amount: initial, currency } }, 'test');
  if (res.status !== 201) throw new Error(`wallet creation failed: ${JSON.stringify(res)}`);
  return { id: (res.body as { id: string }).id, playerId };
}

export function txBody(w: TestWallet, over: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...over,
  };
}

export const keyOf = (b: { providerId: unknown; externalTransactionId: unknown }) => `${String(b.providerId)}:${String(b.externalTransactionId)}`;

/** `key`: omitido ⇒ "{providerId}:{externalTransactionId}"; `null` ⇒ requisição SEM o header Idempotency-Key. */
export const submit = (api: WageringApi, body: Record<string, unknown>, key?: string | null): Promise<ApiResponse> =>
  api.submitTransaction(key === null ? undefined : (key ?? keyOf(body as never)), body, 'test');

export const bodyOf = <T = Record<string, any>>(r: ApiResponse): T => r.body as T;

/** Invariante final de todos os testes: saldo materializado == saldo reconstruído do razão. */
export async function expectConsistent(runner: BunSqlRunner, walletId: string): Promise<void> {
  const rows = await runner.query<{ stored: string; calculated: string; version: number; maxv: number | null }>(
    `select w.balance::text as stored, w.version,
            coalesce(sum(case when e.direction='CREDIT' then e.amount else -e.amount end),0)::text as calculated,
            max(e.wallet_version) as maxv
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id where w.id = ? group by w.id, w.balance, w.version`,
    [walletId],
  );
  const r = rows[0];
  if (!r) throw new Error(`wallet ${walletId} not found`);
  if (Number(r.stored) !== Number(r.calculated)) throw new Error(`INCONSISTENT wallet ${walletId}: stored ${r.stored} != ledger ${r.calculated}`);
  if (r.maxv !== null && Number(r.version) !== Number(r.maxv)) throw new Error(`INCONSISTENT wallet ${walletId}: version ${r.version} != ledger head ${r.maxv}`);
}

export async function balanceOf(runner: BunSqlRunner, walletId: string): Promise<string> {
  return (await runner.query<{ b: string }>(`select balance::text as b from wallets where id = ?`, [walletId]))[0]?.b as string;
}

export async function countEntries(runner: BunSqlRunner, walletId: string, direction?: 'DEBIT' | 'CREDIT'): Promise<number> {
  const rows = await runner.query<{ n: string }>(
    `select count(*)::text as n from wallet_ledger_entries where wallet_id = ? ${direction ? `and direction = '${direction}'` : ''}`,
    [walletId],
  );
  return Number(rows[0]?.n);
}
