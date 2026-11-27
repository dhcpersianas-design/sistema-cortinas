import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Banco = NodePgDatabase<typeof schema>;

export function conectar(databaseUrl: string): { pool: pg.Pool; db: Banco } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { pool, db: drizzle(pool, { schema }) };
}
