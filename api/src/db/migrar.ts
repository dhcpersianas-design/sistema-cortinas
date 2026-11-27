import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** api/db/migracoes (funciona em src/ via tsx e em dist/ após build). */
export const PASTA_MIGRACOES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migracoes');

/**
 * Aplica, em ordem, os arquivos NNNN_*.sql ainda não registrados em
 * `migracoes_aplicadas`. Cada arquivo roda numa transação. Arquivo já aplicado
 * nunca é reexecutado: mudança de estrutura = arquivo novo.
 */
export async function migrar(pool: pg.Pool, pasta = PASTA_MIGRACOES): Promise<string[]> {
  const cliente = await pool.connect();
  try {
    await cliente.query(`CREATE TABLE IF NOT EXISTS migracoes_aplicadas (
      arquivo VARCHAR(200) PRIMARY KEY, aplicada_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // Evita duas instâncias migrando ao mesmo tempo.
    await cliente.query('SELECT pg_advisory_lock(727001)');
    const { rows } = await cliente.query<{ arquivo: string }>('SELECT arquivo FROM migracoes_aplicadas');
    const feitas = new Set(rows.map((r) => r.arquivo));
    const arquivos = readdirSync(pasta).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const aplicadas: string[] = [];
    for (const arquivo of arquivos) {
      if (feitas.has(arquivo)) continue;
      const sql = readFileSync(join(pasta, arquivo), 'utf-8');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migracoes_aplicadas (arquivo) VALUES ($1)', [arquivo]);
        await cliente.query('COMMIT');
      } catch (e) {
        await cliente.query('ROLLBACK');
        throw new Error(`Falha na migração ${arquivo}: ${(e as Error).message}`);
      }
      aplicadas.push(arquivo);
    }
    return aplicadas;
  } finally {
    await cliente.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    cliente.release();
  }
}
