import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WagerMessageHandler, type TransactionExecutor } from '../../src/application/message-handler';
import { OutboxPublisher, type EventSender, type OutboundEvent } from '../../src/application/outbox-publisher';
import type { SqlExecutor, TransactionRunner } from '../../src/infra/persistence/ports';
import {
  balanceOf, buildStack, countEntries, createWallet, expectConsistent, setupSchema, txBody, type Stack, type TestWallet,
} from './helpers';

const CONSUMER = 'wager-transactions-consumer';
let stack: Stack;
const wallets: string[] = [];

beforeAll(async () => {
  await setupSchema();
  stack = buildStack();
});
afterAll(async () => {
  for (const id of wallets) await expectConsistent(stack.runner, id);
  const bad = await stack.runner.query(
    `select w.id from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      group by w.id, w.balance having w.balance <> coalesce(sum(case when e.direction='CREDIT' then e.amount else -e.amount end),0)`,
  );
  expect(bad).toHaveLength(0); // invariante global: saldo == razão em TODAS as carteiras
  await stack.runner.close();
});

const newWallet = async (initial = '100.00'): Promise<TestWallet> => {
  const w = await createWallet(stack.api, initial);
  wallets.push(w.id);
  return w;
};
const handler = (executor: TransactionExecutor = stack.processor, maxAttempts = 5) =>
  new WagerMessageHandler(executor, stack.metrics, { consumerName: CONSUMER, maxAttempts });

function envelope(body: Record<string, unknown>, messageId = randomUUID()) {
  const { providerId, externalTransactionId } = body as { providerId: string; externalTransactionId: string };
  return JSON.stringify({
    messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: `${providerId}:${externalTransactionId}` },
  });
}
const txStatus = async (ext: string) =>
  (await stack.runner.query<{ status: string; failure_code: string | null }>(
    `select status, failure_code from wager_transactions where external_transaction_id = ?`, [ext]))[0];

describe('consumidor SQS (handler)', () => {
  test('mensagem válida → ack; mesma mensagem reentregue → duplicata, um único débito', async () => {
    const w = await newWallet();
    const b = txBody(w, { money: { amount: '30.00', currency: 'BRL' } });
    const raw = envelope(b, 'msg-redelivery-' + randomUUID());
    const d1 = await handler().handle(raw, 1);
    expect(d1.action).toBe('ack');
    // simula: worker morreu depois do commit e antes do ack → SQS reentrega
    const d2 = await handler().handle(raw, 2);
    expect(d2.action).toBe('ack');
    if (d1.action === 'ack' && d2.action === 'ack') {
      expect(d2.result.idempotentReplay).toBe(true);
      expect(d2.result.transactionId).toBe(d1.result.transactionId);
    }
    expect(await balanceOf(stack.runner, w.id)).toBe('70.00');
    expect(await countEntries(stack.runner, w.id, 'DEBIT')).toBe(1);
  });

  test('50 entregas concorrentes da mesma mensagem (várias instâncias) → um débito', async () => {
    const w = await newWallet();
    const raw = envelope(txBody(w, { money: { amount: '10.00', currency: 'BRL' } }), 'msg-' + randomUUID());
    const other = buildStack();
    const ds = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? handler() : new WagerMessageHandler(other.processor, other.metrics, { consumerName: CONSUMER, maxAttempts: 5 })).handle(raw, 1)));
    expect(ds.every((d) => d.action === 'ack')).toBe(true);
    expect(await balanceOf(stack.runner, w.id)).toBe('90.00');
    expect(await countEntries(stack.runner, w.id, 'DEBIT')).toBe(1);
    await other.runner.close();
  });

  test('erro de negócio (saldo insuficiente) → ack (REJECTED registrada, sem retry)', async () => {
    const w = await newWallet('5.00');
    const b = txBody(w, { money: { amount: '80.00', currency: 'BRL' } });
    const d = await handler().handle(envelope(b), 1);
    expect(d.action).toBe('ack');
    expect((await txStatus(b.externalTransactionId as string))?.failure_code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(stack.runner, w.id)).toBe('5.00');
  });

  test('JSON inválido, schema inválido e OPENING → DLQ (permanente)', async () => {
    const w = await newWallet();
    expect(await handler().handle('{not json', 1)).toMatchObject({ action: 'dlq', reason: 'INVALID_JSON' });
    expect(await handler().handle(envelope(txBody(w, { money: { amount: '1.234', currency: 'BRL' } })), 1)).toMatchObject({ action: 'dlq', reason: 'INVALID_MESSAGE' });
    expect(await handler().handle(envelope(txBody(w, { kind: 'OPENING' })), 1)).toMatchObject({ action: 'dlq', reason: 'INVALID_MESSAGE' });
    expect(await handler().handle(JSON.stringify({ messageId: 'x', type: 'Other', occurredAt: new Date().toISOString(), data: {} }), 1)).toMatchObject({ action: 'dlq' });
  });

  test('mesma messageId com payload diferente → DLQ (conflito), saldo intacto', async () => {
    const w = await newWallet();
    const id = 'msg-conflict-' + randomUUID();
    const b = txBody(w);
    expect((await handler().handle(envelope(b, id), 1)).action).toBe('ack');
    const d = await handler().handle(envelope({ ...b, money: { amount: '1.00', currency: 'BRL' } }, id), 1);
    expect(d.action).toBe('dlq');
    expect(await balanceOf(stack.runner, w.id)).toBe('75.00');
  });

  test('falha transitória → retry com backoff; ao esgotar tentativas → FAILED + DLQ', async () => {
    const w = await newWallet();
    const b = txBody(w);
    const broken: TransactionExecutor = {
      execute: async () => { throw new Error('connection terminated unexpectedly'); },
      recordFailure: (cmd, code) => stack.processor.recordFailure(cmd, code),
    };
    const raw = envelope(b);
    const r1 = await handler(broken).handle(raw, 1);
    expect(r1).toMatchObject({ action: 'retry', delaySeconds: 2 });
    const r3 = await handler(broken).handle(raw, 3);
    expect(r3).toMatchObject({ action: 'retry', delaySeconds: 8 });
    expect(await txStatus(b.externalTransactionId as string)).toBeUndefined(); // nada gravado ainda
    const last = await handler(broken).handle(raw, 5);
    expect(last).toMatchObject({ action: 'dlq', reason: 'PROCESSING_EXHAUSTED' });
    expect(await txStatus(b.externalTransactionId as string)).toMatchObject({ status: 'FAILED', failure_code: 'PROCESSING_EXHAUSTED' });
    expect(await balanceOf(stack.runner, w.id)).toBe('100.00'); // FAILED não mexe no saldo
    expect(stack.metrics.render()).toContain('wager_dlq_messages_total');
  });

  test('se nem FAILED consegue gravar (banco fora), devolve à fila em vez de perder', async () => {
    const w = await newWallet();
    const dead: TransactionExecutor = {
      execute: async () => { throw new Error('ECONNREFUSED'); },
      recordFailure: async () => { throw new Error('ECONNREFUSED'); },
    };
    expect((await handler(dead).handle(envelope(txBody(w)), 9)).action).toBe('retry');
  });

  test('REFUND antes da BET (fora de ordem) → ack (pendente) e resolve quando a BET chega', async () => {
    const w = await newWallet();
    const bet = txBody(w, { externalTransactionId: 'bet-' + randomUUID() });
    const refund = txBody(w, { kind: 'REFUND', externalTransactionId: 'ref-' + randomUUID(), referenceExternalTransactionId: bet.externalTransactionId });
    const d = await handler().handle(envelope(refund), 1);
    expect(d).toMatchObject({ action: 'ack', result: { status: 'PENDING_REFERENCE' } });
    expect((await handler().handle(envelope(bet), 1)).action).toBe('ack');
    expect((await txStatus(refund.externalTransactionId as string))?.status).toBe('PROCESSED');
    expect(await balanceOf(stack.runner, w.id)).toBe('100.00');
  });
});

// ------------------------------------------------------------------ outbox
class CollectingSender implements EventSender {
  sent: OutboundEvent[] = [];
  async send(e: OutboundEvent) { this.sent.push(e); }
}
const mine = (s: CollectingSender, w: TestWallet) => s.sent.filter((e) => e.body.includes(w.id));

describe('publisher da outbox', () => {
  test('eventos só existem após o commit e ficam pendentes até publicar (recuperação)', async () => {
    const w = await newWallet();
    await stack.api.submitTransaction('ob-1-' + w.id, txBody(w), 'test');
    const pending = await stack.runner.query(`select 1 from outbox_messages where published_at is null and payload::text like ?`, [`%${w.id}%`]);
    expect(pending.length).toBeGreaterThan(0); // "app caiu antes de publicar": nada se perdeu
    const s = new CollectingSender();
    const pub = new OutboxPublisher(stack.runner, s, stack.metrics);
    while ((await pub.drainOnce(100)) > 0);
    expect(mine(s, w).length).toBe(pending.length);
    expect(await stack.runner.query(`select 1 from outbox_messages where published_at is null and payload::text like ?`, [`%${w.id}%`])).toHaveLength(0);
  });

  test('dois publishers concorrentes: cada evento sai exatamente uma vez', async () => {
    const w = await newWallet('1000.00');
    for (let i = 0; i < 20; i++) await stack.api.submitTransaction(`ob2-${w.id}-${i}`, txBody(w, { money: { amount: '1.00', currency: 'BRL' } }), 'test');
    const a = new CollectingSender();
    const b = new CollectingSender();
    const other = buildStack();
    const pa = new OutboxPublisher(stack.runner, a, stack.metrics);
    const pb = new OutboxPublisher(other.runner, b, other.metrics);
    const loop = async (p: OutboxPublisher) => { while ((await p.drainOnce(5)) > 0); };
    await Promise.all([loop(pa), loop(pb)]);
    const ids = [...mine(a, w), ...mine(b, w)].map((e) => e.eventId);
    expect(ids.length).toBeGreaterThanOrEqual(40); // 20 × (Processed + BalanceChanged)
    expect(new Set(ids).size).toBe(ids.length);
    await other.runner.close();
  });

  test('crash após enviar e antes de commitar → reenvia com o MESMO eventId (consumidor deduplica)', async () => {
    const w = await newWallet();
    await stack.api.submitTransaction('ob3-' + w.id, txBody(w), 'test');
    const s = new CollectingSender();
    const crashing: TransactionRunner = {
      transactional: (fn) => stack.runner.transactional(async (db: SqlExecutor) => { await fn(db); throw new Error('process killed before commit'); }),
    };
    await expect(new OutboxPublisher(crashing, s, stack.metrics).drainOnce(1000)).rejects.toThrow('killed');
    const first = mine(s, w).map((e) => e.eventId);
    expect(first.length).toBeGreaterThan(0);
    const pub = new OutboxPublisher(stack.runner, s, stack.metrics);
    while ((await pub.drainOnce(1000)) > 0);
    const second = mine(s, w).map((e) => e.eventId).slice(first.length);
    expect(second.sort()).toEqual([...first].sort());
  });

  test('destino indisponível → attempts++, next_attempt_at com backoff, last_error; depois publica', async () => {
    const w = await newWallet();
    await stack.api.submitTransaction('ob4-' + w.id, txBody(w), 'test');
    const failing: EventSender = { send: async () => { throw new Error('SQS down'); } };
    const drained = await new OutboxPublisher(stack.runner, failing, stack.metrics).drainOnce(1000);
    expect(drained).toBe(0);
    const rows = await stack.runner.query<{ attempts: number; last_error: string; next_attempt_at: Date | null; published_at: Date | null }>(
      `select attempts, last_error, next_attempt_at, published_at from outbox_messages where attempts > 0 and last_error = 'SQS down' order by occurred_at limit 1`);
    expect(rows[0]).toBeDefined();
    expect(Number(rows[0]?.attempts)).toBe(1);
    expect(rows[0]?.next_attempt_at).not.toBeNull();
    expect(rows[0]?.published_at).toBeNull();
    // ainda não venceu o backoff: não é reenviado imediatamente
    const s = new CollectingSender();
    await new OutboxPublisher(stack.runner, s, stack.metrics).drainOnce(1000);
    expect(s.sent.some((e) => e.eventId === (rows as any)[0].id)).toBe(false);
  });

  test('métrica de lag reflete eventos pendentes', async () => {
    const w = await newWallet();
    await stack.api.submitTransaction('ob5-' + w.id, txBody(w), 'test');
    const pub = new OutboxPublisher(stack.runner, new CollectingSender(), stack.metrics);
    expect(await pub.updateLagMetric()).toBeGreaterThanOrEqual(0);
    expect(stack.metrics.render()).toContain('wager_outbox_lag_seconds');
  });
});

// ------------------------------------------------------------------ worker de pendências
describe('worker de PENDING_REFERENCE', () => {
  test('referência nunca chega → após o limite de tentativas vira REJECTED + evento', async () => {
    const s = buildStack({ pendingBaseDelaySeconds: 0, pendingMaxDelaySeconds: 0, pendingMaxAttempts: 3, pendingTtlSeconds: 3600 });
    const w = await newWallet();
    const refund = txBody(w, { kind: 'REFUND', externalTransactionId: 'orph-' + randomUUID(), referenceExternalTransactionId: 'never-' + randomUUID() });
    const r = await s.api.submitTransaction('orph-' + w.id, refund, 'test');
    expect(r.status).toBe(202);
    for (let i = 0; i < 6; i++) await s.processor.processDuePending();
    expect(await txStatus(refund.externalTransactionId as string)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    const ev = await stack.runner.query(`select 1 from outbox_messages where event_type = 'WagerTransactionRejected' and payload::text like ?`, [`%${refund.externalTransactionId}%`]);
    expect(ev.length).toBe(1);
    expect(await balanceOf(stack.runner, w.id)).toBe('100.00');
    await s.runner.close();
  });

  test('TTL vencido → REJECTED na próxima rodada', async () => {
    const s = buildStack({ pendingBaseDelaySeconds: 0, pendingMaxDelaySeconds: 0, pendingMaxAttempts: 100, pendingTtlSeconds: 0 });
    const w = await newWallet();
    const rb = txBody(w, { kind: 'ROLLBACK', externalTransactionId: 'ttl-' + randomUUID(), referenceExternalTransactionId: 'none-' + randomUUID() });
    expect((await s.api.submitTransaction('ttl-' + w.id, rb, 'test')).status).toBe(202);
    for (let i = 0; i < 3; i++) await s.processor.processDuePending();
    expect((await txStatus(rb.externalTransactionId as string))?.status).toBe('REJECTED');
    await s.runner.close();
  });

  test('backoff exponencial: tentativa não vencida não é reprocessada', async () => {
    const s = buildStack({ pendingBaseDelaySeconds: 5, pendingMaxDelaySeconds: 300, pendingMaxAttempts: 8, pendingTtlSeconds: 3600 });
    const w = await newWallet();
    const refund = txBody(w, { kind: 'REFUND', externalTransactionId: 'bo-' + randomUUID(), referenceExternalTransactionId: 'nope-' + randomUUID() });
    await s.api.submitTransaction('bo-' + w.id, refund, 'test');
    const next = async () => (await stack.runner.query<{ n: Date; a: number }>(`select next_attempt_at as n, attempts as a from wager_transactions where external_transaction_id = ?`, [refund.externalTransactionId]))[0]!;
    const before = await next();
    expect(await s.processor.processDuePending()).toBe(0); // ainda não venceu
    const mid = await next();
    expect(new Date(mid.n).getTime()).toBe(new Date(before.n).getTime());
    // força vencimento e confere crescimento do atraso
    await stack.runner.query(`update wager_transactions set next_attempt_at = now() where external_transaction_id = ?`, [refund.externalTransactionId]);
    await s.processor.processDuePending();
    const after = await next();
    expect(Number(after.a)).toBeGreaterThan(Number(before.a));
    expect(new Date(after.n).getTime() - Date.now()).toBeGreaterThan(6_000); // ≈10s (5·2¹)
    await s.runner.close();
  });

  test('workers concorrentes não resolvem a mesma pendência duas vezes', async () => {
    const w = await newWallet();
    const stacks = [buildStack(), buildStack(), buildStack()].map((x) => x);
    const bet = txBody(w, { externalTransactionId: 'cb-' + randomUUID() });
    const refunds = Array.from({ length: 5 }, (_, i) => txBody(w, { kind: 'REFUND', externalTransactionId: `cr-${i}-${randomUUID()}`, referenceExternalTransactionId: bet.externalTransactionId }));
    for (const r of refunds) await stack.api.submitTransaction('k-' + r.externalTransactionId, r, 'test');
    await stack.api.submitTransaction('k-' + bet.externalTransactionId, bet, 'test'); // drena: exatamente 1 reembolso vence
    await Promise.all(stacks.map((x) => x.processor.processDuePending()));
    const rows = await stack.runner.query<{ status: string }>(`select status from wager_transactions where wallet_id = ? and kind = 'REFUND'`, [w.id]);
    expect(rows.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'REJECTED')).toHaveLength(4);
    expect(await balanceOf(stack.runner, w.id)).toBe('100.00');
    for (const x of stacks) await x.runner.close();
  });
});

// ------------------------------------------------------------------ multi-processo + reinício
describe('multi-processo e reinício', () => {
  test('3 processos disputando as mesmas 20 apostas de 10.00 numa carteira de 100.00', async () => {
    const w = await newWallet('100.00');
    const procs = Array.from({ length: 3 }, () =>
      Bun.spawn(['bun', 'test/integration/worker-process.ts'], {
        env: { ...process.env, WALLET_ID: w.id, PLAYER_ID: w.playerId, COUNT: '20', AMOUNT: '10.00' }, stdout: 'pipe', stderr: 'pipe',
      }));
    const outs = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })));
    for (const o of outs) expect(o.code, o.err).toBe(0);
    const rows = await stack.runner.query<{ status: string }>(`select status from wager_transactions where wallet_id = ? and kind = 'BET'`, [w.id]);
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.status === 'PROCESSED')).toHaveLength(10);
    expect(rows.filter((r) => r.status === 'REJECTED')).toHaveLength(10);
    expect(await balanceOf(stack.runner, w.id)).toBe('0.00');
    expect(await countEntries(stack.runner, w.id, 'DEBIT')).toBe(10);
  }, 60_000);

  test('cenário obrigatório entre processos: 100.00, duas apostas de 80.00', async () => {
    const w = await newWallet('100.00');
    const procs = [0, 1].map(() =>
      Bun.spawn(['bun', 'test/integration/worker-process.ts'], {
        env: { ...process.env, WALLET_ID: w.id, PLAYER_ID: w.playerId, COUNT: '2', AMOUNT: '80.00' }, stdout: 'pipe', stderr: 'pipe' }));
    await Promise.all(procs.map((p) => p.exited));
    expect(await balanceOf(stack.runner, w.id)).toBe('20.00');
    expect(await countEntries(stack.runner, w.id, 'DEBIT')).toBe(1);
  }, 60_000);

  test('reinício: novo pool reproduz tudo como duplicata e o estado persiste', async () => {
    const w = await newWallet();
    const b = txBody(w, { money: { amount: '40.00', currency: 'BRL' } });
    const key = 'restart-' + w.id;
    const first = await stack.api.submitTransaction(key, b, 'test');
    const fresh = buildStack(); // "processo reiniciado": nenhuma memória anterior
    const again = await fresh.api.submitTransaction(key, b, 'test');
    expect(again.status).toBe(first.status);
    expect((again.body as any).transactionId).toBe((first.body as any).transactionId);
    expect(await balanceOf(fresh.runner, w.id)).toBe('60.00');
    expect(await countEntries(fresh.runner, w.id, 'DEBIT')).toBe(1);
    await fresh.runner.close();
  });
});
