import type { MikroORM } from '@mikro-orm/postgresql';
import type { SqlExecutor, TransactionRunner } from './ports';

/**
 * Adaptador MikroORM da porta TransactionRunner: `EntityManager.transactional()` abre/commita/dá
 * rollback; `em.execute()` roda os statements na MESMA conexão/transação. Cada chamada usa um fork do
 * EntityManager (Identity Map próprio), então não há estado compartilhado entre requisições concorrentes.
 */
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly orm: MikroORM) {}

  transactional<T>(fn: (db: SqlExecutor) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional((em) =>
      fn({ execute: async <R>(sql: string, params: readonly unknown[] = []) => (await em.execute(sql, [...params])) as unknown as R[] }),
    );
  }
}
