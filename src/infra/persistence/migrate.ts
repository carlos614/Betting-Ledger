import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './orm.config';

/** Uso: bun src/infra/persistence/migrate.ts up|down */
const direction = process.argv[2] ?? 'up';

const orm = await MikroORM.init(buildOrmConfig());
try {
  const migrator = orm.migrator;
  if (direction === 'up') {
    const done = await migrator.up();
    console.log(`applied: ${done.map((m) => m.name).join(', ') || '(nothing to do)'}`);
  } else if (direction === 'down') {
    const done = await migrator.down();
    console.log(`reverted: ${done.map((m) => m.name).join(', ') || '(nothing to do)'}`);
  } else {
    throw new Error(`unknown direction "${direction}" (use up|down)`);
  }
} finally {
  await orm.close();
}
