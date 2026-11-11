/**
 * Portas de persistência usadas pela camada de aplicação. Em produção são implementadas pelo
 * MikroORM (`EntityManager.transactional` + `em.execute`); nos testes, por um pool Bun.sql.
 * Os statements usam `?` como placeholder (estilo MikroORM).
 */
export interface SqlExecutor {
  execute<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface TransactionRunner {
  /** Executa `fn` numa transação PostgreSQL: commit se resolver, rollback total se lançar. */
  transactional<T>(fn: (db: SqlExecutor) => Promise<T>): Promise<T>;
}
