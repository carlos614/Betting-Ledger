/**
 * Infra de testes de integração: implementa a porta TransactionRunner sobre `Bun.sql` (pool real do
 * PostgreSQL). A MESMA lógica de aplicação roda aqui e em produção; só o adaptador muda
 * (em produção: MikroORM `em.transactional`).
 */
import { SQL } from 'bun';
import type { SqlExecutor, TransactionRunner } from '../../src/infra/persistence/ports';
import { downSql, upSql } from '../../src/infra/persistence/schema';

export const DATABASE_URL = process.env.DATABASE_URL;

/** troca `?` por `$1, $2…` (os statements da aplicação usam o estilo do MikroORM). */
export function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export class BunSqlRunner implements TransactionRunner {
  readonly sql: SQL;

  constructor(url: string = DATABASE_URL as string, max = 20) {
    this.sql = new SQL({ url, max });
  }

  async transactional<T>(fn: (db: SqlExecutor) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (tx) =>
      fn({ execute: async <R>(q: string, p: readonly unknown[] = []) => (await tx.unsafe(toPg(q), [...p])) as unknown as R[] }),
    )) as T;
  }

  /** consulta avulsa (fora de transação de negócio) */
  async query<R = Record<string, unknown>>(q: string, p: readonly unknown[] = []): Promise<R[]> {
    return (await this.sql.unsafe(toPg(q), [...p])) as unknown as R[];
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

/** Aplica o esquema se ainda não existir (no Docker o Migrator já o aplicou). */
export async function ensureSchema(runner: BunSqlRunner): Promise<void> {
  const rows = await runner.query<{ t: string | null }>(`select to_regclass('public.wager_transactions')::text as t`);
  if (rows[0]?.t) return;
  for (const s of upSql) await runner.query(s);
}

export async function dropSchema(runner: BunSqlRunner): Promise<void> {
  for (const s of downSql) await runner.query(s);
}
