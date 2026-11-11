/**
 * Esquema SQL (versão 1). Fica separado da classe de migração para poder ser aplicado tanto pelo
 * MikroORM Migrator quanto pelos testes. TODAS as garantias das seções 5/6/8 vivem aqui:
 *
 *  unicidade / idempotência   idempotency_key, (provider_id, external_transaction_id), (player_id, currency),
 *                             inbox (consumer_name, message_id), 1 lançamento por (wallet, transação)
 *  não-negatividade           CHECK wallets.balance >= 0, ledger.balance_after >= 0
 *  imutabilidade              ledger append-only (UPDATE/DELETE/TRUNCATE), transações terminais, sem DELETE
 *  saldo == razão             constraint triggers DEFERRED validam no COMMIT: cadeia do razão, saldo = último
 *                             lançamento, version = última versão, e "lançamento ⇔ transação PROCESSED que move saldo"
 *  version                    inicia em 1; só incrementa (exatamente +1) quando o saldo muda
 *  uma reversão por referência índice parcial único em wager_transactions(reference_transaction_id)
 */
export const upSql: string[] = [
  // ------------------------------------------------------------------ wallets
  `create table wallets (
     id          uuid primary key,
     player_id   uuid          not null,
     currency    varchar(3)    not null,
     balance     numeric(20,2) not null default 0,
     version     integer       not null default 1,
     created_at  timestamptz   not null default now(),
     updated_at  timestamptz   not null default now(),
     constraint wallets_currency_iso    check (currency ~ '^[A-Z]{3}$'),
     constraint wallets_balance_non_neg check (balance >= 0),
     constraint wallets_version_pos     check (version >= 1),
     constraint wallets_one_per_player_currency unique (player_id, currency)
   )`,

  // ------------------------------------------------------------------ transações
  // wallet_id NÃO tem FK de propósito: uma transação para wallet inexistente precisa ser
  // persistida como REJECTED/WALLET_NOT_FOUND (auditável) em vez de falhar na inserção.
  `create table wager_transactions (
     id                                uuid primary key,
     provider_id                       varchar(64)   not null,
     external_transaction_id           varchar(128)  not null,
     idempotency_key                   varchar(255)  not null,
     payload_hash                      char(64)      not null,
     wallet_id                         uuid          not null,
     player_id                         uuid          not null,
     round_id                          varchar(128)  not null,
     game_id                           varchar(128)  not null,
     kind                              text          not null,
     amount                            numeric(20,2) not null,
     currency                          varchar(3)    not null,
     reference_external_transaction_id varchar(128),
     reference_transaction_id          uuid references wager_transactions(id),
     status                            text          not null,
     failure_code                      text,
     attempts                          integer       not null default 0,
     next_attempt_at                   timestamptz,
     result_balance                    numeric(20,2),
     correlation_id                    text,
     created_at                        timestamptz   not null default now(),
     processed_at                      timestamptz,
     constraint wtx_idempotency_key_unique   unique (idempotency_key),
     constraint wtx_external_id_unique       unique (provider_id, external_transaction_id),
     constraint wtx_kind_valid               check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
     constraint wtx_status_valid             check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
     constraint wtx_amount_positive          check (amount > 0),
     constraint wtx_currency_iso             check (currency ~ '^[A-Z]{3}$'),
     constraint wtx_reference_required       check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
     constraint wtx_reference_resolved       check (reference_transaction_id is null or reference_external_transaction_id is not null),
     constraint wtx_failure_code_iff_failed  check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
     constraint wtx_processed_at_iff_final   check ((status in ('PROCESSED','REJECTED','FAILED')) = (processed_at is not null)),
     constraint wtx_pending_has_schedule     check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null)
   )`,
  `create index wtx_wallet_idx on wager_transactions (wallet_id, created_at desc)`,
  `create index wtx_pending_due_idx on wager_transactions (next_attempt_at) where status = 'PENDING_REFERENCE'`,
  `create index wtx_pending_by_reference_idx on wager_transactions (provider_id, reference_external_transaction_id)
     where status = 'PENDING_REFERENCE'`,
  // Uma referência só pode ser revertida UMA vez (REFUND/ROLLBACK processado), mesmo com bug de aplicação.
  `create unique index wtx_one_reversal_per_reference on wager_transactions (reference_transaction_id)
     where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'`,

  // ------------------------------------------------------------------ razão (append-only)
  `create table wallet_ledger_entries (
     id             uuid primary key,
     wallet_id      uuid          not null references wallets(id),
     transaction_id uuid          not null references wager_transactions(id),
     direction      text          not null,
     amount         numeric(20,2) not null,
     balance_before numeric(20,2) not null,
     balance_after  numeric(20,2) not null,
     wallet_version integer       not null,
     created_at     timestamptz   not null default now(),
     constraint ledger_direction_valid    check (direction in ('DEBIT','CREDIT')),
     constraint ledger_amount_positive    check (amount > 0),
     constraint ledger_before_non_neg     check (balance_before >= 0),
     constraint ledger_after_non_neg      check (balance_after >= 0),
     constraint ledger_arithmetic         check (
       (direction = 'CREDIT' and balance_before + amount = balance_after) or
       (direction = 'DEBIT'  and balance_before - amount = balance_after)),
     constraint ledger_version_pos        check (wallet_version >= 1),
     -- no máximo um lançamento por wallet para cada transação financeira
     constraint ledger_one_per_wallet_tx  unique (wallet_id, transaction_id),
     constraint ledger_chain_version      unique (wallet_id, wallet_version)
   )`,
  `create index ledger_transaction_idx on wallet_ledger_entries (transaction_id)`,

  // ------------------------------------------------------------------ inbox / outbox
  `create table inbox_messages (
     message_id    varchar(128) not null,
     consumer_name varchar(128) not null,
     payload_hash  char(64)     not null,
     received_at   timestamptz  not null default now(),
     processed_at  timestamptz,
     primary key (consumer_name, message_id)
   )`,

  `create table outbox_messages (
     id              uuid primary key,
     aggregate_id    text        not null,
     event_type      text        not null,
     payload         jsonb       not null,
     occurred_at     timestamptz not null,
     attempts        integer     not null default 0,
     next_attempt_at timestamptz,
     published_at    timestamptz,
     last_error      text,
     constraint outbox_attempts_non_neg check (attempts >= 0)
   )`,
  `create index outbox_pending_idx on outbox_messages (occurred_at, id) where published_at is null`,

  // ------------------------------------------------------------------ imutabilidade
  `create function ledger_forbid_mutation() returns trigger language plpgsql as $$
   begin
     raise exception '% on % is not allowed (append-only / immutable)', TG_OP, TG_TABLE_NAME using errcode = '55000';
   end $$`,
  `create trigger ledger_no_update_delete before update or delete on wallet_ledger_entries
     for each row execute function ledger_forbid_mutation()`,
  `create trigger ledger_no_truncate before truncate on wallet_ledger_entries
     for each statement execute function ledger_forbid_mutation()`,
  `create trigger wallets_no_delete before delete on wallets for each row execute function ledger_forbid_mutation()`,
  `create trigger wtx_no_delete before delete on wager_transactions for each row execute function ledger_forbid_mutation()`,

  // Transação: terminal é terminal; campos de negócio imutáveis; transições válidas.
  `create function wtx_guard_update() returns trigger language plpgsql as $$
   begin
     if OLD.status in ('PROCESSED','REJECTED','FAILED') then
       raise exception 'transaction % is terminal (%)', OLD.id, OLD.status using errcode = '55000';
     end if;
     if NEW.id <> OLD.id or NEW.provider_id <> OLD.provider_id or NEW.external_transaction_id <> OLD.external_transaction_id
        or NEW.idempotency_key <> OLD.idempotency_key or NEW.payload_hash <> OLD.payload_hash
        or NEW.wallet_id <> OLD.wallet_id or NEW.player_id <> OLD.player_id or NEW.round_id <> OLD.round_id
        or NEW.game_id <> OLD.game_id or NEW.kind <> OLD.kind or NEW.amount <> OLD.amount or NEW.currency <> OLD.currency
        or NEW.reference_external_transaction_id is distinct from OLD.reference_external_transaction_id
        or NEW.created_at <> OLD.created_at then
       raise exception 'immutable columns of transaction % cannot change', OLD.id using errcode = '55000';
     end if;
     if OLD.status = 'PENDING_REFERENCE' and NEW.status = 'PENDING' then
       raise exception 'invalid transition PENDING_REFERENCE -> PENDING' using errcode = '55000';
     end if;
     return NEW;
   end $$`,
  `create trigger wtx_guard before update on wager_transactions for each row execute function wtx_guard_update()`,

  // Wallet: version só muda (exatamente +1) quando o saldo muda; identidade imutável.
  `create function wallets_guard_update() returns trigger language plpgsql as $$
   begin
     if NEW.id <> OLD.id or NEW.player_id <> OLD.player_id or NEW.currency <> OLD.currency or NEW.created_at <> OLD.created_at then
       raise exception 'immutable columns of wallet % cannot change', OLD.id using errcode = '55000';
     end if;
     if NEW.balance <> OLD.balance then
       if NEW.version <> OLD.version + 1 then
         raise exception 'wallet % version must increase by exactly 1 when the balance changes', OLD.id using errcode = '23514';
       end if;
     elsif NEW.version <> OLD.version then
       raise exception 'wallet % version can only change together with the balance', OLD.id using errcode = '23514';
     end if;
     return NEW;
   end $$`,
  `create trigger wallets_guard before update on wallets for each row execute function wallets_guard_update()`,

  // ------------------------------------------------------------------ saldo == razão (no COMMIT)
  // Todos os checks leem o ESTADO ATUAL das tabelas (não o NEW do evento): a mesma linha pode ser
  // atualizada várias vezes na mesma transação e só o resultado final precisa ser consistente.
  `create function ledger_check_entry() returns trigger language plpgsql as $$
   declare
     prev numeric(20,2);
     tx   record;
   begin
     if NEW.wallet_version = 1 then
       prev := 0;
     else
       select balance_after into prev from wallet_ledger_entries
        where wallet_id = NEW.wallet_id and wallet_version = NEW.wallet_version - 1;
       if not found then
         if NEW.wallet_version = 2 then
           prev := 0; -- carteira aberta com saldo zero: sem lançamento de abertura
         else
           raise exception 'ledger gap: wallet % has no entry for version %', NEW.wallet_id, NEW.wallet_version - 1 using errcode = '23514';
         end if;
       end if;
     end if;
     if NEW.balance_before <> prev then
       raise exception 'ledger chain broken: wallet % version % starts at % but previous balance is %',
         NEW.wallet_id, NEW.wallet_version, NEW.balance_before, prev using errcode = '23514';
     end if;
     select status, kind, wallet_id into tx from wager_transactions where id = NEW.transaction_id;
     if tx.status is distinct from 'PROCESSED' or tx.kind = 'LOSS' or tx.wallet_id <> NEW.wallet_id then
       raise exception 'ledger entry % must belong to a PROCESSED balance-affecting transaction of the same wallet', NEW.id using errcode = '23514';
     end if;
     return null;
   end $$`,
  `create constraint trigger ledger_entry_check after insert on wallet_ledger_entries
     deferrable initially deferred for each row execute function ledger_check_entry()`,

  `create function wallet_check_matches_ledger() returns trigger language plpgsql as $$
   declare
     cur  record;
     head record;
   begin
     select balance, version into cur from wallets where id = NEW.id;
     select balance_after, wallet_version into head from wallet_ledger_entries
      where wallet_id = NEW.id order by wallet_version desc limit 1;
     if not found then
       if cur.balance <> 0 or cur.version <> 1 then
         raise exception 'wallet % has balance % / version % but no ledger entries', NEW.id, cur.balance, cur.version using errcode = '23514';
       end if;
     elsif cur.balance <> head.balance_after or cur.version <> head.wallet_version then
       raise exception 'wallet % (balance %, version %) does not match its ledger head (balance %, version %)',
         NEW.id, cur.balance, cur.version, head.balance_after, head.wallet_version using errcode = '23514';
     end if;
     return null;
   end $$`,
  `create constraint trigger wallet_matches_ledger after insert or update on wallets
     deferrable initially deferred for each row execute function wallet_check_matches_ledger()`,

  // Transação PROCESSED que move saldo ⇒ tem lançamento; as demais (LOSS, REJECTED, FAILED, pendentes) ⇒ não têm.
  `create function wtx_check_ledger_presence() returns trigger language plpgsql as $$
   declare
     cur record;
     n   integer;
   begin
     select status, kind into cur from wager_transactions where id = NEW.id;
     select count(*) into n from wallet_ledger_entries where transaction_id = NEW.id;
     if cur.status = 'PROCESSED' and cur.kind <> 'LOSS' then
       if n <> 1 then
         raise exception 'processed transaction % must have exactly one ledger entry (has %)', NEW.id, n using errcode = '23514';
       end if;
     elsif n <> 0 then
       raise exception 'transaction % (% %) must not have ledger entries', NEW.id, cur.status, cur.kind using errcode = '23514';
     end if;
     return null;
   end $$`,
  `create constraint trigger wtx_ledger_presence after insert or update on wager_transactions
     deferrable initially deferred for each row execute function wtx_check_ledger_presence()`,
];

export const downSql: string[] = [
  `drop trigger if exists wtx_ledger_presence on wager_transactions`,
  `drop trigger if exists wallet_matches_ledger on wallets`,
  `drop trigger if exists ledger_entry_check on wallet_ledger_entries`,
  `drop function if exists wtx_check_ledger_presence()`,
  `drop function if exists wallet_check_matches_ledger()`,
  `drop function if exists ledger_check_entry()`,
  `drop trigger if exists wallets_guard on wallets`,
  `drop trigger if exists wtx_guard on wager_transactions`,
  `drop function if exists wallets_guard_update()`,
  `drop function if exists wtx_guard_update()`,
  `drop trigger if exists wtx_no_delete on wager_transactions`,
  `drop trigger if exists wallets_no_delete on wallets`,
  `drop trigger if exists ledger_no_truncate on wallet_ledger_entries`,
  `drop trigger if exists ledger_no_update_delete on wallet_ledger_entries`,
  `drop function if exists ledger_forbid_mutation()`,
  `drop table if exists outbox_messages`,
  `drop table if exists inbox_messages`,
  `drop table if exists wallet_ledger_entries`,
  `drop table if exists wager_transactions`,
  `drop table if exists wallets`,
];
