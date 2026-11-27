import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectar } from '../db/conexao.js';
import { lerConfig } from '../config.js';

/** Carrega os 29 SKUs fictícios da especificação. Só para desenvolvimento/demonstração. */
export const ARQUIVO_EXEMPLO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'exemplo', 'produtos-exemplo.sql');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = conectar(lerConfig().databaseUrl);
  try {
    const r = await pool.query(readFileSync(ARQUIVO_EXEMPLO, 'utf-8'));
    console.log(`Produtos de exemplo inseridos: ${(r as unknown as { rowCount: number }).rowCount ?? 0} (SKUs já existentes foram mantidos).`);
  } finally {
    await pool.end();
  }
}
