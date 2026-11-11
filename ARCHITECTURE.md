# ARCHITECTURE

Serviço financeiro de apostas: Bun · TypeScript estrito · NestJS · MikroORM · PostgreSQL · SQS.
Este documento descreve **o que está implementado**; a seção 10 lista o que ainda falta e o que só foi compilado.

```
HTTP ─▶ Controllers (finos) ─▶ WageringApi ─▶ WagerProcessor ─┐  uma transação PostgreSQL:
                                (status/erros)   (caso de uso) │  inbox · wager_transactions · wallets (FOR UPDATE)
SQS  ─▶ WagerConsumer ─▶ WagerMessageHandler ──▶ mesmo caso ───┘  wallet_ledger_entries · outbox_messages
```

## 1. Camadas

| Camada | Conteúdo | Dependências |
|---|---|---|
| `domain/` | Money, Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage, eventos, FailureCode, hash | nenhuma (nem ORM, nem Nest) |
| `application/` | `WagerProcessor` (caso de uso único), `WalletService`, `TransactionQueries`, validação (zod), métricas, logs | portas `TransactionRunner`/`SqlExecutor` |
| `http/` | `WageringApi` (framework-agnóstica) + controllers/filtro/guard do Nest | Nest |
| `infra/` | adaptador MikroORM da porta, schema SQL, migração, SQS | MikroORM, AWS SDK |

A lógica de negócio e de HTTP **não conhece o Nest**: os controllers só repassam para `WageringApi`. Por isso o mesmo código roda nos testes contra um PostgreSQL real (adaptador Bun.sql da porta) e em produção (adaptador MikroORM).

## 2. API HTTP e mapeamento de status

O mapeamento mora num único lugar (`http/api.ts`), logo é idêntico em todos os endpoints. Cada situação tem um código próprio e um campo `retryable` nos erros:

| HTTP | Situação | Corpo | Reenviar? |
|---|---|---|---|
| 200 | transação `PROCESSED` (ou replay) | `{transactionId,status,balance,idempotentReplay}` | não, concluída |
| 201 | wallet criada | wallet | — |
| 202 | `PENDING_REFERENCE`: aceita, processamento pendente | idem + `Location` | **não**; consulte `GET` |
| 400 | payload inválido (incl. falta de `Idempotency-Key`, uuid/cursor/limit ruins) | `{error:{code:"INVALID_PAYLOAD",retryable:false,details}}` | só após corrigir |
| 404 | recurso inexistente | `{error:{code:"NOT_FOUND"}}` | — |
| 409 | conflito de idempotência (`IDEMPOTENCY_CONFLICT`) ou wallet duplicada (`WALLET_ALREADY_EXISTS`) | `{error:{code,...}}` | **não** com a mesma key |
| 422 | rejeição por regra de negócio (`REJECTED`) | `{…,status:"REJECTED",failureCode,advice}` | conforme `advice` |
| 503 | falha transitória de infraestrutura | `{error:{code:"TRANSIENT_FAILURE",retryable:true}}` + `Retry-After` | **sim**, mesma key (seguro) |
| 500 | erro interno / `FAILED` | `{error:{code:"INTERNAL_ERROR"}}` | contatar suporte |

Erros do próprio framework (rota inexistente, JSON malformado) saem no mesmo envelope (`ApiExceptionFilter`). `x-correlation-id` é aceito/gerado e devolvido em toda resposta. `/health/*` e `/metrics` não exigem autenticação.

## 3. Idempotência

* `Idempotency-Key` é obrigatória e é a fonte da verdade (padrão recomendado `{providerId}:{externalTransactionId}`).
* **payloadHash** — algoritmo: (1) projeta **só** os campos de negócio `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`; (2) normaliza o valor (`"25"` ≡ `"25.00"`); (3) omite `undefined`; (4) JSON canônico com chaves ordenadas recursivamente; (5) SHA-256 hex. Header, `messageId` e `occurredAt` **não** entram.
* A unicidade é decidida **pelo banco**: `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`, com `INSERT … ON CONFLICT DO NOTHING`. Sem cache em memória.
* Mesma key + mesmo hash → replay: devolve o resultado **original**, inclusive o saldo observado na época (`result_balance`), com `idempotentReplay:true`.
* Mesma key + hash diferente, ou mesmo id externo sob outra key → `409`, nunca replay.
* Duplicatas concorrentes: a segunda transação bloqueia no lock da wallet / no índice único até a primeira terminar.

## 4. Concorrência

**Unidade de concorrência = `walletId`; estratégia: lock pessimista por linha** (`SELECT … FOR UPDATE`) + defesa em profundidade:

1. o `UPDATE` da wallet é condicionado a `version = esperada` (0 linhas ⇒ lost update detectado ⇒ erro);
2. `CHECK (balance >= 0)` e trigger de `version` (+1 exato, só quando o saldo muda);
3. triggers deferidos validam, no COMMIT, que saldo, `version` e razão batem.

Ordem de locks fixa (sem deadlock entre transações do sistema): **wallet → linhas pendentes que dependem da transação**. Wallets diferentes não se bloqueiam; não há lock global. Escolhi pessimista porque wallets quentes têm alta contenção (retry otimista geraria tempestade de conflitos) e a seção crítica é curta. `lock_timeout` (10 s) converte espera excessiva em erro transitório (`503`/retry), contado em `wager_lock_conflicts_total`.

## 5. Garantias aplicadas no esquema (`infra/persistence/schema.ts`)

| Invariante | Mecanismo no banco |
|---|---|
| uma wallet por `playerId`+`currency` | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK balance >= 0`, `CHECK balance_after >= 0` |
| `version` só muda com o saldo | trigger `wallets_guard` |
| razão imutável | triggers bloqueiam `UPDATE/DELETE/TRUNCATE` em `wallet_ledger_entries` |
| aritmética do lançamento | `CHECK` (`before ± amount = after`) |
| no máximo 1 lançamento por wallet e transação | `UNIQUE (wallet_id, transaction_id)` |
| cadeia do razão sem buracos | `UNIQUE (wallet_id, wallet_version)` + trigger deferido (`balance_before` = `balance_after` anterior) |
| saldo == razão | trigger deferido: saldo e `version` da wallet = último lançamento |
| lançamento ⇔ transação `PROCESSED` que move saldo | trigger deferido nos dois sentidos (LOSS, REJECTED, FAILED e pendentes **não** têm lançamento) |
| estados terminais não mudam | trigger `wtx_guard`; sem `DELETE` |
| uma reversão por referência | índice único parcial em `reference_transaction_id` (REFUND/ROLLBACK processados) |
| REFUND/ROLLBACK exigem referência | `CHECK` |
| `failure_code` ⇔ REJECTED/FAILED; `processed_at` ⇔ terminal | `CHECK` |

Os triggers deferidos leem o **estado atual** das tabelas (não o `NEW` do evento), pois a mesma linha pode ser atualizada várias vezes na mesma transação. `wager_transactions.wallet_id` não tem FK de propósito: uma transação para wallet inexistente é persistida como `REJECTED/WALLET_NOT_FOUND` (auditável).

## 6. Regras de negócio e códigos de falha

`BET` debita. `WIN` credita (pode referenciar um BET). `LOSS` não move saldo nem gera lançamento. `REFUND` credita o valor do BET referenciado. `ROLLBACK` é o inverso da referência (BET→crédito, WIN→débito, REFUND→débito). A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve ser do mesmo player, wallet, moeda e rodada; REFUND só referencia BET; ROLLBACK referencia BET/WIN/REFUND; valor de REFUND/ROLLBACK = valor da referência.

**Interpretação adotada (documentada):** o enunciado diz que uma referência não pode ser revertida duas vezes *pelo mesmo tipo*. Adotei a regra mais estrita: **uma referência só é revertida uma vez por qualquer REFUND/ROLLBACK**, senão BET→REFUND→ROLLBACK creditaria duas vezes. Idem para WIN/LOSS sobre BET já revertido (`ALREADY_REVERSED`).

| `failureCode` | Significado | `advice` |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | `WAIT_AND_RESUBMIT` |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK que debitaria além do saldo (distinto do anterior) | `WAIT_AND_RESUBMIT` |
| `WALLET_NOT_FOUND` · `PLAYER_MISMATCH` · `CURRENCY_MISMATCH` | dados da operação incoerentes com a wallet | `FIX_PAYLOAD` |
| `INVALID_REFERENCE_KIND` · `REFERENCE_{WALLET,PLAYER,CURRENCY,ROUND,AMOUNT}_MISMATCH` | referência incompatível | `FIX_PAYLOAD` |
| `ALREADY_REVERSED` | referência já revertida | `GIVE_UP` |
| `REFERENCE_NOT_FOUND` | referência nunca chegou (limite do `PENDING_REFERENCE`) | `WAIT_AND_RESUBMIT` |
| `REFERENCE_NOT_PROCESSED` | referência rejeitada/falha, ou não resolvida a tempo | `GIVE_UP` |
| `PROCESSING_EXHAUSTED` (`FAILED`) | erro técnico persistente após N tentativas | `CONTACT_SUPPORT` |

Os valores são contrato com o provedor: só se acrescenta, nunca se renomeia.

### Referências fora de ordem (PENDING_REFERENCE)
Referência ausente → `PENDING_REFERENCE`, `202` e evento `WagerTransactionPendingReference`. Quando a transação referenciada é processada (mesma wallet), os dependentes são aplicados **na mesma transação** (`drain`). Há também reavaliação periódica (`processDuePending`) com **backoff exponencial 5·2ⁿ s (teto 300 s)**; limite de **8 tentativas ou TTL de 30 min** (o que vier primeiro) ⇒ `REJECTED/REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`. Justificativa: provedores normalmente reenviam em segundos/minutos; 30 min cobre filas atrasadas sem manter dinheiro em limbo indefinido. Parâmetros por variável de ambiente.

## 7. Modelo de domínio

Construtor privado + fábricas estáticas (`from`, `zero`, `open`, `create`, `enqueue`, `receive`, `rehydrate`); `rehydrate` não revalida transições. **Money**: `bigint` em centavos (escala fixa 2, espelha `NUMERIC(20,2)`), serializa sempre com 2 casas, rejeita `''`, `NaN`, `Infinity`, notação científica, >2 casas e negativos nos contratos; nenhum `number` toca em dinheiro. Opto por `bigint` em vez de `decimal.js` (zero dependências; a escala é fixa). **WagerTransaction**: transições `PENDING → PROCESSED|REJECTED|FAILED|PENDING_REFERENCE` e `PENDING_REFERENCE → PROCESSED|REJECTED|FAILED`; terminais lançam `InvalidTransactionStateError`. **Ledger**: sem setters; `create` valida a aritmética. **Wallet**: `debit/credit` devolvem o lançamento, então saldo e razão não divergem na aplicação.

## 8. ORM e estratégia transacional

MikroORM 6 fornece pool, `EntityManager.transactional()` (fork por chamada ⇒ Identity Map próprio, sem estado compartilhado) e Migrator. **Os writes financeiros usam SQL explícito** (`em.execute`, na mesma transação) porque dependem de `ON CONFLICT DO NOTHING`, `FOR UPDATE` e updates condicionados por versão — pontos em que o Unit of Work esconderia justamente o que precisa estar visível e auditável. Não há entidades mapeadas: é uma escolha consciente, não omissão. Migrações versionadas e reversíveis (`up`/`down` testados). A porta `TransactionRunner` permite testar a lógica real contra PostgreSQL sem subir o Nest.

## 8a. Mensageria (consumidor, outbox, workers)

**Consumidor** (`infra/sqs/wager-consumer.ts` + `application/message-handler.ts`). A decisão (`ack | retry | dlq`) fica no handler, sem I/O de SQS, e usa o **mesmo `WagerProcessor.execute`** da API HTTP. Deduplicação pela **inbox persistente** `(consumer_name, message_id)` na mesma transação financeira; `DeleteMessage` só depois do COMMIT. Se o worker morre entre commit e ack, a mensagem reaparece e vira duplicata (mesmo `transactionId`, um único débito).

| Situação | Ação |
|---|---|
| processada / rejeitada por negócio / `PENDING_REFERENCE` / duplicata | ack (o estado terminal já está gravado) |
| JSON ou schema inválido, `OPENING`, mesma `messageId` com payload diferente | DLQ imediata (permanente; retry não adianta) |
| falha transitória (conexão, lock timeout) | `ChangeMessageVisibility` com backoff `min(2^n, 120)` s |
| tentativas esgotadas (`CONSUMER_MAX_ATTEMPTS`=5 < redrive do SQS=10) | grava `FAILED/PROCESSING_EXHAUSTED` (auditável) e envia à DLQ; se nem isso grava, devolve à fila |

FIFO é só otimização: mensagens do mesmo `MessageGroupId` rodam em sequência, grupos em paralelo, mas **a correção não depende da ordem** (o banco decide). SIGTERM: aborta o long poll, conclui as mensagens em andamento e devolve as não iniciadas com visibilidade 0.

**Outbox** (`application/outbox-publisher.ts`). `SELECT … FOR UPDATE SKIP LOCKED` reparte linhas entre N publishers; envia e marca `published_at` na mesma transação. Crash depois de enviar e antes de commitar ⇒ rollback ⇒ outra instância reenvia com o **mesmo `eventId`** (at-least-once; consumidores deduplicam por `eventId`). Falha de envio ⇒ `attempts++`, `next_attempt_at` exponencial, `last_error`. Nada é publicado antes do commit financeiro porque a linha só existe depois dele. Métrica `wager_outbox_lag_seconds`.

**Workers** (`infra/workers.ts`): `OutboxWorker` e `PendingReferenceWorker` (chama `processDuePending`) fazem polling com parada graciosa; ambos seguros com N instâncias. Desligáveis por `CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_WORKER_ENABLED`.

## 9. Observabilidade

Logs JSON (uma linha/evento) com `correlationId, messageId, transactionId, walletId, providerId`; valores monetários e payloads **não** são logados (filtro por nome de campo). `GET /metrics` (Prometheus): `wager_transactions_total{status,kind}`, `wager_duplicates_total`, `wager_retries_total`, `wager_lock_conflicts_total`, `wager_processing_duration_seconds`, `wager_reconciliations_total`, `wager_reconciliation_divergences_total`, `wager_dlq_messages_total{reason}`, `wager_outbox_lag_seconds`. Divergência de reconciliação **não é corrigida**: é logada (`error`), contada e sinalizada (`consistent:false`).

## 10. Status e pendências (transparência)

**Implementado e testado contra PostgreSQL real:** domínio, esquema (up/down), caso de uso, API HTTP completa (seção 9), idempotência, concorrência (cenário obrigatório 100,00 / 2×80,00; mesma aposta ×50; 60 apostas distintas; wallets em paralelo), referências fora de ordem, reconciliação, paginação por cursor.

**Também implementado e testado (PostgreSQL real):** handler do consumidor (redelivery pós-commit, 50 entregas concorrentes, DLQ, retry→FAILED, fora de ordem), publisher da outbox (2 publishers concorrentes, crash antes/depois do envio, backoff, lag), worker de pendências (limite, TTL, backoff, concorrência), **3 processos** disputando as mesmas apostas, reinício e invariante global saldo == razão.

**Não executado aqui:** o laço de I/O com SQS (`WagerConsumer`, `SqsEventSender`) e a fiação Nest/MikroORM só foram **compilados**; o redrive/DLQ reais dependem do LocalStack. Não há teste automatizado com LocalStack neste ambiente (sem Docker); rode `docker compose up` para exercitá-lo. Interface web: `src/ui/index.html`, servida em `GET /` por `UiController`. Foi validada em navegador real (Playwright) contra a API e o PostgreSQL; o `UiController` em si, dentro do Nest, só foi compilado.

**Autenticação (seção 2): não implementada, por decisão.** Ponto de extensão explícito: `IdentityProviderPort` + `AuthGuard` (hoje `NoopIdentityProvider`). Desenho previsto: Keycloak (OIDC) no Compose, adapter que valida o JWT via JWKS (`iss`, `aud`, `exp`) e mapeia roles; provedores autenticariam por client-credentials com claim casando `providers`. Sem tabela própria de usuários/senhas. Health e métricas ficam abertos.

**Verificação:** a camada de aplicação/HTTP e o esquema foram executados aqui contra PostgreSQL 16. Os adaptadores NestJS/MikroORM/SQS **compilam** (bundle) mas não foram executados neste ambiente (sem Docker/rede): rode `docker compose up` e `bun run typecheck` para validá-los.
