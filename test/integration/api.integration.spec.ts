/**
 * API HTTP (camada WageringApi) contra PostgreSQL REAL.
 *   DATABASE_URL=postgres://ledger:ledger@localhost:5433/ledger bun run test:integration
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WageringApi } from '../../src/http/api';
import {
  DATABASE_URL, balanceOf, bodyOf, buildStack, countEntries, createWallet, expectConsistent, keyOf, setupSchema, submit, txBody, type Stack,
} from './helpers';

describe.skipIf(!DATABASE_URL)('API HTTP', () => {
  let s: Stack;
  beforeAll(async () => {
    await setupSchema();
    s = buildStack();
  });
  afterAll(async () => {
    await s.runner.close();
  });

  describe('POST /wallets', () => {
    test('201 com o formato do enunciado; OPENING + CREDIT + version 1 + eventos na outbox', async () => {
      const playerId = randomUUID();
      const res = await s.api.createWallet({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } }, 'c1');
      expect(res.status).toBe(201);
      expect(bodyOf(res)).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
      const id = bodyOf(res).id as string;

      const entries = await s.runner.query<{ direction: string; amount: string; balance_before: string; balance_after: string; wallet_version: number; kind: string }>(
        `select e.direction, e.amount::text amount, e.balance_before::text balance_before, e.balance_after::text balance_after, e.wallet_version, t.kind
           from wallet_ledger_entries e join wager_transactions t on t.id = e.transaction_id where e.wallet_id = ?`, [id]);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00', kind: 'OPENING' });
      expect(Number(entries[0]?.wallet_version)).toBe(1);

      const events = await s.runner.query<{ event_type: string }>(`select event_type from outbox_messages where aggregate_id = ? order by event_type`, [id]);
      expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      await expectConsistent(s.runner, id);
    });

    test('saldo inicial zero: sem OPENING nem lançamento; version 1', async () => {
      const res = await s.api.createWallet({ playerId: randomUUID(), initialBalance: { amount: '0.00', currency: 'BRL' } }, 'c');
      expect(res.status).toBe(201);
      expect(bodyOf(res).version).toBe(1);
      expect(await countEntries(s.runner, bodyOf(res).id)).toBe(0);
    });

    test('409 WALLET_ALREADY_EXISTS para o mesmo playerId + currency; outra moeda é permitida', async () => {
      const playerId = randomUUID();
      const make = (currency: string) => s.api.createWallet({ playerId, initialBalance: { amount: '10.00', currency } }, 'c');
      expect((await make('BRL')).status).toBe(201);
      const dup = await make('BRL');
      expect(dup.status).toBe(409);
      expect(bodyOf(dup).error.code).toBe('WALLET_ALREADY_EXISTS');
      expect((await make('USD')).status).toBe(201);
    });

    test('criações concorrentes do mesmo player: exatamente uma vence', async () => {
      const playerId = randomUUID();
      const results = await Promise.all(Array.from({ length: 10 }, () => s.api.createWallet({ playerId, initialBalance: { amount: '5.00', currency: 'BRL' } }, 'c')));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    });

    test('400 INVALID_PAYLOAD: sem playerId, uuid ruim, valor negativo, 3 casas, campo extra, number', async () => {
      const bad: unknown[] = [
        {}, { initialBalance: { amount: '1.00', currency: 'BRL' } },
        { playerId: 'x', initialBalance: { amount: '1.00', currency: 'BRL' } },
        { playerId: randomUUID(), initialBalance: { amount: '-1.00', currency: 'BRL' } },
        { playerId: randomUUID(), initialBalance: { amount: '1.001', currency: 'BRL' } },
        { playerId: randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } },
        { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' }, extra: 1 },
      ];
      for (const b of bad) {
        const r = await s.api.createWallet(b, 'c');
        expect(r.status).toBe(400);
        expect(bodyOf(r).error.code).toBe('INVALID_PAYLOAD');
        expect(bodyOf(r).error.retryable).toBe(false);
      }
    });
  });

  describe('GET /wallets/:id', () => {
    test('200, 404 e 400 (uuid inválido)', async () => {
      const w = await createWallet(s.api, '42.50');
      const ok = await s.api.getWallet(w.id, 'c');
      expect(ok.status).toBe(200);
      expect(bodyOf(ok)).toEqual({ id: w.id, playerId: w.playerId, balance: { amount: '42.50', currency: 'BRL' }, version: 1 });
      expect((await s.api.getWallet(randomUUID(), 'c')).status).toBe(404);
      expect((await s.api.getWallet('not-a-uuid', 'c')).status).toBe(400);
    });
  });

  describe('POST /wagering/transactions', () => {
    test('BET → 200 PROCESSED com o formato do enunciado (saldo 975.00)', async () => {
      const w = await createWallet(s.api, '1000.00');
      const body = txBody(w);
      const res = await submit(s.api, body);
      expect(res.status).toBe(200);
      expect(bodyOf(res)).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
      expect((await s.api.getWallet(w.id, 'c')).body).toMatchObject({ balance: { amount: '975.00', currency: 'BRL' }, version: 2 });
      await expectConsistent(s.runner, w.id);
    });

    test('replay idêntico → mesma resposta (mesmo saldo observado na época) com idempotentReplay: true', async () => {
      const w = await createWallet(s.api, '100.00');
      const b1 = txBody(w, { money: { amount: '10.00', currency: 'BRL' } });
      const first = bodyOf(await submit(s.api, b1));
      await submit(s.api, txBody(w, { money: { amount: '30.00', currency: 'BRL' } })); // o saldo muda depois
      const replay = await submit(s.api, b1);
      expect(replay.status).toBe(200);
      expect(bodyOf(replay)).toEqual({ ...first, idempotentReplay: true });
      expect(bodyOf(replay).balance.amount).toBe('90.00'); // saldo daquele momento, não o atual (60.00)
      expect(await balanceOf(s.runner, w.id)).toBe('60.00');
    });

    test('replay com valor equivalente ("25" == "25.00") continua replay', async () => {
      const w = await createWallet(s.api, '100.00');
      const b = txBody(w, { money: { amount: '25.00', currency: 'BRL' } });
      await submit(s.api, b);
      const again = await submit(s.api, { ...b, money: { amount: '25', currency: 'BRL' } });
      expect(again.status).toBe(200);
      expect(bodyOf(again).idempotentReplay).toBe(true);
    });

    test('409 IDEMPOTENCY_CONFLICT: mesma key com payload diferente (nunca replay)', async () => {
      const w = await createWallet(s.api, '100.00');
      const b = txBody(w, { money: { amount: '10.00', currency: 'BRL' } });
      await submit(s.api, b);
      const conflict = await submit(s.api, { ...b, money: { amount: '11.00', currency: 'BRL' } });
      expect(conflict.status).toBe(409);
      expect(bodyOf(conflict).error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(bodyOf(conflict).error.retryable).toBe(false);
      expect(await balanceOf(s.runner, w.id)).toBe('90.00');
      // mesmo externalTransactionId sob outra key também é conflito
      expect((await submit(s.api, b, 'another-key')).status).toBe(409);
    });

    test('a key é a fonte da verdade: o header não entra no hash, mas a key diferente com mesmo id externo conflita', async () => {
      const w = await createWallet(s.api, '100.00');
      const b = txBody(w);
      const key = `custom-key-${randomUUID()}`; // a key não precisa seguir o padrão recomendado
      expect((await submit(s.api, b, key)).status).toBe(200);
      const replay = await submit(s.api, b, key);
      expect(bodyOf(replay).idempotentReplay).toBe(true);
      expect((await submit(s.api, b)).status).toBe(409); // mesmo id externo sob a key padrão: conflito
    });

    test('400: sem Idempotency-Key, key inválida, corpo inválido e OPENING (interno)', async () => {
      const w = await createWallet(s.api);
      const b = txBody(w);
      expect((await submit(s.api, b, null)).status).toBe(400);
      expect((await submit(s.api, b, '')).status).toBe(400);
      expect((await submit(s.api, b, 'has space')).status).toBe(400);
      expect((await submit(s.api, { ...b, kind: 'OPENING' })).status).toBe(400);
      expect((await submit(s.api, { ...b, kind: 'REFUND' })).status).toBe(400); // sem referência
      expect((await submit(s.api, { ...b, money: { amount: '0.00', currency: 'BRL' } })).status).toBe(400);
      expect((await submit(s.api, { ...b, money: { amount: '1.005', currency: 'BRL' } })).status).toBe(400);
      expect((await submit(s.api, { ...b, money: { amount: 25, currency: 'BRL' } })).status).toBe(400);
      expect((await submit(s.api, { ...b, providerId: 'Provider A' })).status).toBe(400);
      expect(await countEntries(s.runner, w.id, 'DEBIT')).toBe(0);
    });

    test('422 REJECTED com failureCode: saldo insuficiente; replay devolve a mesma rejeição', async () => {
      const w = await createWallet(s.api, '10.00');
      const b = txBody(w, { money: { amount: '80.00', currency: 'BRL' } });
      const res = await submit(s.api, b);
      expect(res.status).toBe(422);
      expect(bodyOf(res)).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', advice: 'WAIT_AND_RESUBMIT', balance: { amount: '10.00' }, idempotentReplay: false });
      const replay = await submit(s.api, b);
      expect(replay.status).toBe(422);
      expect(bodyOf(replay).idempotentReplay).toBe(true);
      expect(await countEntries(s.runner, w.id, 'DEBIT')).toBe(0); // REJECTED não gera lançamento
      expect(await balanceOf(s.runner, w.id)).toBe('10.00');
    });

    test('422 por wallet inexistente, player errado e moeda errada (auditáveis)', async () => {
      const w = await createWallet(s.api);
      const noWallet = await submit(s.api, txBody({ id: randomUUID(), playerId: randomUUID() }));
      expect(noWallet.status).toBe(422);
      expect(bodyOf(noWallet).failureCode).toBe('WALLET_NOT_FOUND');
      expect(bodyOf(await submit(s.api, txBody(w, { playerId: randomUUID() }))).failureCode).toBe('PLAYER_MISMATCH');
      expect(bodyOf(await submit(s.api, txBody(w, { money: { amount: '1.00', currency: 'USD' } }))).failureCode).toBe('CURRENCY_MISMATCH');
    });

    test('LOSS: PROCESSED sem lançamento e sem mudar saldo/version', async () => {
      const w = await createWallet(s.api, '100.00');
      const bet = txBody(w, { money: { amount: '10.00', currency: 'BRL' } });
      await submit(s.api, bet);
      const loss = await submit(s.api, txBody(w, { kind: 'LOSS', referenceExternalTransactionId: bet.externalTransactionId, money: { amount: '10.00', currency: 'BRL' } }));
      expect(loss.status).toBe(200);
      expect(bodyOf(loss).balance.amount).toBe('90.00');
      expect(await countEntries(s.runner, w.id)).toBe(2); // OPENING + BET (nenhum para LOSS)
      expect(bodyOf(await s.api.getWallet(w.id, 'c')).version).toBe(2);
    });

    test('WIN credita; REFUND/ROLLBACK revertem uma única vez', async () => {
      const w = await createWallet(s.api, '100.00');
      const bet = txBody(w, { money: { amount: '40.00', currency: 'BRL' } });
      await submit(s.api, bet);
      const ref = bet.externalTransactionId as string;
      const win = await submit(s.api, txBody(w, { kind: 'WIN', referenceExternalTransactionId: ref, money: { amount: '100.00', currency: 'BRL' } }));
      expect(bodyOf(win).balance.amount).toBe('160.00');

      const refund = txBody(w, { kind: 'REFUND', referenceExternalTransactionId: ref, money: { amount: '40.00', currency: 'BRL' } });
      expect(bodyOf(await submit(s.api, refund)).balance.amount).toBe('200.00');
      const again = await submit(s.api, txBody(w, { kind: 'REFUND', referenceExternalTransactionId: ref, money: { amount: '40.00', currency: 'BRL' } }));
      expect(again.status).toBe(422);
      expect(bodyOf(again).failureCode).toBe('ALREADY_REVERSED');
      // ROLLBACK do mesmo BET também é bloqueado (uma reversão por referência)
      const rb = await submit(s.api, txBody(w, { kind: 'ROLLBACK', referenceExternalTransactionId: ref, money: { amount: '40.00', currency: 'BRL' } }));
      expect(bodyOf(rb).failureCode).toBe('ALREADY_REVERSED');
      expect(await balanceOf(s.runner, w.id)).toBe('200.00');
      await expectConsistent(s.runner, w.id);
    });
  });

  describe('cenários de concorrência (seção 8)', () => {
    test('OBRIGATÓRIO: saldo 100.00, duas apostas de 80.00 simultâneas → 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito', async () => {
      const w = await createWallet(s.api, '100.00');
      const bets = [txBody(w, { money: { amount: '80.00', currency: 'BRL' } }), txBody(w, { money: { amount: '80.00', currency: 'BRL' } })];
      const results = await Promise.all(bets.map((b) => submit(s.api, b)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(bodyOf(results.find((r) => r.status === 422)!).failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(s.runner, w.id)).toBe('20.00');
      expect(await countEntries(s.runner, w.id, 'DEBIT')).toBe(1);
      // nenhum retry duplica o débito
      await Promise.all([...bets, ...bets].map((b) => submit(s.api, b)));
      expect(await countEntries(s.runner, w.id, 'DEBIT')).toBe(1);
      expect(await balanceOf(s.runner, w.id)).toBe('20.00');
      await expectConsistent(s.runner, w.id);
    });

    test('a mesma aposta enviada 50 vezes em paralelo → um único débito', async () => {
      const w = await createWallet(s.api, '100.00');
      const b = txBody(w, { money: { amount: '30.00', currency: 'BRL' } });
      const results = await Promise.all(Array.from({ length: 50 }, () => submit(s.api, b)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => bodyOf(r).idempotentReplay === false)).toHaveLength(1);
      expect(results.filter((r) => bodyOf(r).idempotentReplay === true)).toHaveLength(49);
      expect(new Set(results.map((r) => bodyOf(r).transactionId)).size).toBe(1);
      expect(await countEntries(s.runner, w.id, 'DEBIT')).toBe(1);
      expect(await balanceOf(s.runner, w.id)).toBe('70.00');
    });

    test('60 apostas distintas de 10.00 em paralelo sobre 100.00 → exatamente 10 aceitas, saldo 0.00', async () => {
      const w = await createWallet(s.api, '100.00');
      const results = await Promise.all(Array.from({ length: 60 }, () => submit(s.api, txBody(w, { money: { amount: '10.00', currency: 'BRL' } }))));
      expect(results.filter((r) => r.status === 200)).toHaveLength(10);
      expect(results.filter((r) => r.status === 422)).toHaveLength(50);
      expect(await balanceOf(s.runner, w.id)).toBe('0.00');
      await expectConsistent(s.runner, w.id);
    });

    test('wallets distintas em paralelo: cada uma correta e independente', async () => {
      const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(s.api, '100.00')));
      const all = await Promise.all(wallets.flatMap((w) => Array.from({ length: 4 }, () => submit(s.api, txBody(w, { money: { amount: '30.00', currency: 'BRL' } })))));
      expect(all.filter((r) => r.status === 200)).toHaveLength(20 * 3);
      for (const w of wallets) {
        expect(await balanceOf(s.runner, w.id)).toBe('10.00');
        await expectConsistent(s.runner, w.id);
      }
    });
  });

  describe('referência fora de ordem', () => {
    test('REFUND antes do BET → 202 PENDING_REFERENCE; quando o BET chega, ambos são aplicados', async () => {
      const w = await createWallet(s.api, '100.00');
      const betBody = txBody(w, { money: { amount: '40.00', currency: 'BRL' } });
      const refundBody = txBody(w, { kind: 'REFUND', referenceExternalTransactionId: betBody.externalTransactionId, money: { amount: '40.00', currency: 'BRL' } });

      const pending = await submit(s.api, refundBody);
      expect(pending.status).toBe(202);
      expect(bodyOf(pending).status).toBe('PENDING_REFERENCE');
      expect(pending.headers?.location).toBe(`/wagering/transactions/${bodyOf(pending).transactionId}`);
      expect(await balanceOf(s.runner, w.id)).toBe('100.00');

      expect((await submit(s.api, betBody)).status).toBe(200);
      expect(await balanceOf(s.runner, w.id)).toBe('100.00'); // -40 + 40
      const view = await s.api.getTransaction(bodyOf(pending).transactionId, 'c');
      expect(bodyOf(view)).toMatchObject({ status: 'PROCESSED', kind: 'REFUND' });
      expect(await countEntries(s.runner, w.id, 'DEBIT')).toBe(1);
      await expectConsistent(s.runner, w.id);
    });

    test('BET e ROLLBACK disparados juntos, em ordem aleatória: sempre consistente', async () => {
      for (let i = 0; i < 15; i++) {
        const w = await createWallet(s.api, '100.00');
        const bet = txBody(w, { money: { amount: '40.00', currency: 'BRL' } });
        const rb = txBody(w, { kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId, money: { amount: '40.00', currency: 'BRL' } });
        const order = i % 2 ? [bet, rb] : [rb, bet];
        await Promise.all(order.map((b) => submit(s.api, b)));
        expect(await balanceOf(s.runner, w.id)).toBe('100.00');
        const pending = await s.runner.query(`select 1 from wager_transactions where wallet_id = ? and status = 'PENDING_REFERENCE'`, [w.id]);
        expect(pending).toHaveLength(0);
        await expectConsistent(s.runner, w.id);
      }
    });
  });

  describe('GET consultas de transação', () => {
    test('por id e por (provider, externalId); 404 e 400', async () => {
      const w = await createWallet(s.api);
      const b = txBody(w);
      const { transactionId } = bodyOf(await submit(s.api, b));
      const byId = await s.api.getTransaction(transactionId, 'c');
      expect(byId.status).toBe(200);
      expect(bodyOf(byId)).toMatchObject({ transactionId, providerId: 'provider-a', externalTransactionId: b.externalTransactionId, status: 'PROCESSED', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
      const byExt = await s.api.getProviderTransaction('provider-a', b.externalTransactionId as string, 'c');
      expect(bodyOf(byExt).transactionId).toBe(transactionId);
      expect((await s.api.getTransaction(randomUUID(), 'c')).status).toBe(404);
      expect((await s.api.getProviderTransaction('provider-a', 'nope', 'c')).status).toBe(404);
      expect((await s.api.getTransaction('x', 'c')).status).toBe(400);
      expect((await s.api.getProviderTransaction('BAD PROVIDER', 'x', 'c')).status).toBe(400);
    });
  });

  describe('GET /wallets/:id/ledger', () => {
    test('paginação por cursor opaco e estável, em ordem, sem repetir nem pular', async () => {
      const w = await createWallet(s.api, '1000.00');
      for (let i = 0; i < 7; i++) await submit(s.api, txBody(w, { money: { amount: '1.00', currency: 'BRL' } }));
      const seen: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await s.api.getLedger(w.id, { cursor, limit: '3' }, 'c');
        expect(res.status).toBe(200);
        const page = bodyOf(res);
        expect(page.items.length).toBeLessThanOrEqual(3);
        seen.push(...page.items.map((e: { walletVersion: number }) => e.walletVersion));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor);
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // OPENING + 7 apostas
      expect(pages).toBe(3);
    });

    test('um lançamento novo no meio da paginação não altera as páginas já vistas', async () => {
      const w = await createWallet(s.api, '100.00');
      for (let i = 0; i < 3; i++) await submit(s.api, txBody(w, { money: { amount: '1.00', currency: 'BRL' } }));
      const p1 = bodyOf(await s.api.getLedger(w.id, { limit: '2' }, 'c'));
      await submit(s.api, txBody(w, { money: { amount: '1.00', currency: 'BRL' } }));
      const p2 = bodyOf(await s.api.getLedger(w.id, { cursor: p1.nextCursor, limit: '2' }, 'c'));
      expect([...p1.items, ...p2.items].map((e: { walletVersion: number }) => e.walletVersion)).toEqual([1, 2, 3, 4]);
    });

    test('formato do item, 400 (cursor/limit inválidos) e 404', async () => {
      const w = await createWallet(s.api, '100.00');
      const page = bodyOf(await s.api.getLedger(w.id, {}, 'c'));
      expect(page.items[0]).toEqual({
        id: expect.any(String), transactionId: expect.any(String), direction: 'CREDIT', money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' }, balanceAfter: { amount: '100.00', currency: 'BRL' }, walletVersion: 1, createdAt: expect.any(String),
      });
      expect(page.nextCursor).toBeNull();
      expect((await s.api.getLedger(w.id, { cursor: 'lixo' }, 'c')).status).toBe(400);
      expect((await s.api.getLedger(w.id, { limit: '0' }, 'c')).status).toBe(400);
      expect((await s.api.getLedger(w.id, { limit: '201' }, 'c')).status).toBe(400);
      expect((await s.api.getLedger(w.id, { limit: 'abc' }, 'c')).status).toBe(400);
      expect((await s.api.getLedger(randomUUID(), {}, 'c')).status).toBe(404);
    });
  });

  describe('POST /wallets/:id/reconciliation', () => {
    test('consistente: formato do enunciado', async () => {
      const w = await createWallet(s.api, '1000.00');
      await submit(s.api, txBody(w));
      const res = await s.api.reconcile(w.id, 'c');
      expect(res.status).toBe(200);
      expect(bodyOf(res)).toEqual({
        walletId: w.id, storedBalance: { amount: '975.00', currency: 'BRL' }, calculatedBalance: { amount: '975.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 2,
      });
      expect((await s.api.reconcile(randomUUID(), 'c')).status).toBe(404);
    });

    test('divergência NÃO é corrigida: é sinalizada na resposta e contada em métrica', async () => {
      const w = await createWallet(s.api, '100.00');
      // Só um superusuário com triggers desligados consegue corromper; é exatamente o que a reconciliação detecta.
      await s.runner.query(`alter table wallets disable trigger wallets_guard`);
      await s.runner.query(`alter table wallets disable trigger wallet_matches_ledger`);
      try {
        await s.runner.query(`update wallets set balance = 150.00 where id = ?`, [w.id]);
        const before = s.metrics.counter('wager_reconciliation_divergences_total');
        const res = await s.api.reconcile(w.id, 'c');
        expect(bodyOf(res)).toMatchObject({ consistent: false, storedBalance: { amount: '150.00' }, calculatedBalance: { amount: '100.00' }, difference: { amount: '50.00' } });
        expect(s.metrics.counter('wager_reconciliation_divergences_total')).toBe(before + 1);
        expect(await balanceOf(s.runner, w.id)).toBe('150.00'); // não foi "consertado" em silêncio
      } finally {
        await s.runner.query(`update wallets set balance = 100.00 where id = ?`, [w.id]);
        await s.runner.query(`alter table wallets enable trigger wallets_guard`);
        await s.runner.query(`alter table wallets enable trigger wallet_matches_ledger`);
      }
      expect(bodyOf(await s.api.reconcile(w.id, 'c')).consistent).toBe(true);
    });
  });

  describe('saúde e falhas transitórias', () => {
    test('/health/live e /health/ready (200 com Postgres de pé)', async () => {
      expect(s.api.live()).toEqual({ status: 200, body: { status: 'ok' } });
      const ready = await s.api.ready();
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ok', checks: { postgres: 'up' } });
    });

    test('/health/ready → 503 quando uma dependência cai', async () => {
      const api = new WageringApi(s.processor, s.wallets, s.queries, s.metrics, [
        { name: 'postgres', check: async () => undefined },
        { name: 'sqs', check: async () => { throw new Error('ECONNREFUSED'); } },
      ]);
      const ready = await api.ready();
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
      expect(ready.headers?.['retry-after']).toBe('5');
    });

    test('503 TRANSIENT_FAILURE + Retry-After quando o banco está indisponível; 500 para erro inesperado', async () => {
      const down = {
        transactional: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }); },
      };
      const st = buildStack({}, down as never);
      const w = { id: randomUUID(), playerId: randomUUID() };
      const res = await submit(st.api, txBody(w));
      expect(res.status).toBe(503);
      expect(bodyOf(res).error).toMatchObject({ code: 'TRANSIENT_FAILURE', retryable: true });
      expect(res.headers?.['retry-after']).toBe('1');

      const buggy = { transactional: async () => { throw new TypeError('boom'); } };
      const res2 = await submit(buildStack({}, buggy as never).api, txBody(w));
      expect(res2.status).toBe(500);
      expect(bodyOf(res2).error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: false });
      expect(JSON.stringify(res2.body)).not.toContain('boom'); // não vaza detalhes internos
    });

    test('x-correlation-id é devolvido em todas as respostas', async () => {
      const res = await s.api.getWallet(randomUUID(), 'corr-xyz');
      expect(res.headers?.['x-correlation-id']).toBe('corr-xyz');
    });

    test('status HTTP distintos e consistentes: 400 ≠ 409 ≠ 422 ≠ 202 ≠ 503', async () => {
      const codes = new Set<number>();
      const w = await createWallet(s.api, '10.00');
      const b = txBody(w, { money: { amount: '80.00', currency: 'BRL' } });
      codes.add((await submit(s.api, b, null)).status); // 400
      codes.add((await submit(s.api, b)).status); // 422
      codes.add((await submit(s.api, { ...b, money: { amount: '81.00', currency: 'BRL' } }, keyOf(b))).status); // 409
      codes.add((await submit(s.api, txBody(w, { kind: 'WIN', referenceExternalTransactionId: 'nao-chegou-ainda' }))).status); // 202
      expect([...codes].sort()).toEqual([202, 400, 409, 422]);
    });
  });

  test('métricas Prometheus expostas', async () => {
    const text = s.api.metricsText();
    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED"}');
    expect(text).toContain('wager_processing_duration_seconds_bucket');
    expect(text).toContain('wager_duplicates_total');
  });
});
