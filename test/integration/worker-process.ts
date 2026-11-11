/**
 * Processo-trabalhador usado pelo teste multi-processo: é uma "instância" independente da aplicação
 * (pool e memória próprios) que tenta processar as mesmas apostas que as outras instâncias.
 * Env: WALLET_ID, PLAYER_ID, COUNT, AMOUNT
 */
import { buildStack, submit } from './helpers';

const { WALLET_ID, PLAYER_ID, COUNT = '20', AMOUNT = '10.00' } = process.env;
const stack = buildStack({}, undefined);
const w = { id: WALLET_ID as string, playerId: PLAYER_ID as string };
const results = await Promise.all(
  Array.from({ length: Number(COUNT) }, (_, i) =>
    submit(stack.api, {
      providerId: 'provider-a', externalTransactionId: `mp-${WALLET_ID}-${i}`, playerId: w.playerId, walletId: w.id,
      roundId: 'r1', gameId: 'g1', kind: 'BET', money: { amount: AMOUNT as string, currency: 'BRL' },
    }),
  ),
);
console.log(JSON.stringify(results.map((r) => r.status)));
await stack.runner.close();
