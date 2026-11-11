import { Migration } from '@mikro-orm/migrations';
import { downSql, upSql } from '../schema';

/** Esquema inicial (versionado e reversível). O SQL vive em ../schema.ts para ser reutilizado nos testes. */
export class Migration20261111000000_init extends Migration {
  override async up(): Promise<void> {
    for (const statement of upSql) this.addSql(statement);
  }

  override async down(): Promise<void> {
    for (const statement of downSql) this.addSql(statement);
  }
}
