# betting-ledger

Serviço financeiro de apostas (Bun · TypeScript estrito · NestJS · MikroORM · PostgreSQL · SQS).
Decisões técnicas: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Subir

```powershell

docker compose up -d postgres localstack    # Postgres (porta 5433 do host) + SQS
bun install
bun run migrate:up
bun run start                               # http://localhost:3000
```

Ou tudo no Docker: `docker compose up -d --build app` (porta na faixa 3000-3010; veja `docker compose ps`).

## Testar

```powershell
bun run test                                 # unitários (domínio), sem infraestrutura

$env:DATABASE_URL="postgres://ledger:ledger@localhost:5433/ledger"
bun run test:integration                     # API + concorrência contra PostgreSQL real
```

## Usar a API (PowerShell)

`Invoke-RestMethod` lança exceção em 4xx/5xx; esta função mostra o corpo de qualquer resposta:

```powershell
function Call($method, $url, $body = $null, $headers = @{}) {
  try   { Invoke-RestMethod -Method $method -Uri $url -ContentType 'application/json' -Headers $headers -Body $body }
  catch { $_.ErrorDetails.Message }
}
$api = 'http://localhost:3000'

# 1. criar carteira (saldo inicial gera OPENING + CREDIT no razão)
$player = [guid]::NewGuid().ToString()
$w = Call Post "$api/wallets" (@{ playerId=$player; initialBalance=@{ amount='1000.00'; currency='BRL' } } | ConvertTo-Json)
$w

# 2. apostar 25.00 (Idempotency-Key obrigatória)
$bet = @{ providerId='provider-a'; externalTransactionId='transaction-123'; playerId=$player; walletId=$w.id
          roundId='round-987'; gameId='fortune-chimp'; kind='BET'; money=@{ amount='25.00'; currency='BRL' } } | ConvertTo-Json
Call Post "$api/wagering/transactions" $bet @{ 'Idempotency-Key'='provider-a:transaction-123' }   # 975.00
Call Post "$api/wagering/transactions" $bet @{ 'Idempotency-Key'='provider-a:transaction-123' }   # idempotentReplay: true

# 3. consultas e reconciliação
Call Get  "$api/wallets/$($w.id)"
Call Get  "$api/wallets/$($w.id)/ledger?limit=50"
Call Get  "$api/providers/provider-a/wagering/transactions/transaction-123"
Call Post "$api/wallets/$($w.id)/reconciliation"
Call Get  "$api/health/ready"
```

Tipos aceitos em `kind`: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` (`OPENING` é interno). `REFUND`/`ROLLBACK` exigem `referenceExternalTransactionId`.
Métricas em `GET /metrics`. A raiz `/` não tem página (404 é esperado).

## Status HTTP

`200` processada · `201` wallet criada · `202` aguardando referência · `400` payload inválido · `404` não existe · `409` conflito de idempotência / wallet duplicada · `422` rejeitada por regra de negócio (`failureCode`) · `503` falha transitória (pode reenviar com a mesma key). Detalhes e códigos de falha em ARCHITECTURE.md.

## Interface web

Com a aplicação no ar, abra `http://localhost:3000` (ou a porta publicada pelo Docker, ex.: 3000–3010). A página permite criar carteiras, enviar BET/WIN/LOSS/REFUND/ROLLBACK, reenviar o mesmo pedido (idempotência), rodar cenários de concorrência, ver o razão, reconciliar e consultar transações. Ela só usa a API HTTP pública.
