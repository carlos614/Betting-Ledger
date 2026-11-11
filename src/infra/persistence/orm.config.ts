import { Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver, type Options } from '@mikro-orm/postgresql';
import { config } from '../../config';
import { Migration20261111000000_init } from './migrations/Migration20261111000000_init';

/**
 * MikroORM é usado como gerenciador de conexão/transação (`EntityManager.transactional`) e de migrações.
 * Não há entidades mapeadas: os writes financeiros usam SQL explícito (ON CONFLICT, FOR UPDATE, …) —
 * ver ARCHITECTURE.md §Estratégia transacional.
 */
export function buildOrmConfig(clientUrl: string = config.databaseUrl): Options<PostgreSqlDriver> {
  return {
    driver: PostgreSqlDriver,
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: true,
    extensions: [Migrator],
    migrations: {
      migrationsList: [{ name: 'Migration20261111000000_init', class: Migration20261111000000_init }],
      transactional: true,
      allOrNothing: true,
      disableForeignKeys: false,
    },
    pool: { min: 2, max: 20 },
    debug: false,
  };
}
