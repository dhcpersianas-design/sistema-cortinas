import { conectar } from '../db/conexao.js';
import { migrar } from '../db/migrar.js';
import { lerConfig } from '../config.js';

const { pool } = conectar(lerConfig().databaseUrl);
try {
  const aplicadas = await migrar(pool);
  console.log(aplicadas.length ? `Migrações aplicadas: ${aplicadas.join(', ')}` : 'Banco já está atualizado.');
} finally {
  await pool.end();
}
