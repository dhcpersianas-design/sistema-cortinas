import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { LIMITES_SEMAFORO_PADRAO, semaforoMargem, type CorSemaforo } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { parametrosSistema } from '../db/schema.js';

/** Valor vigente hoje de um parâmetro (maior `vigente_desde` <= hoje). */
export async function parametro(db: Banco, lojaId: string, chave: string): Promise<string | null> {
  const [l] = await db.select({ valor: parametrosSistema.valor }).from(parametrosSistema)
    .where(and(eq(parametrosSistema.lojaId, lojaId), eq(parametrosSistema.chave, chave), lte(parametrosSistema.vigenteDesde, sql`CURRENT_DATE`)))
    .orderBy(desc(parametrosSistema.vigenteDesde)).limit(1);
  return l?.valor ?? null;
}

/** Semáforo de margem: regra do motor de cálculo com os limites vigentes do banco. */
export async function semaforo(db: Banco, lojaId: string, margemPct: string): Promise<CorSemaforo> {
  const verdeMinPct = (await parametro(db, lojaId, 'SEMAFORO_VERDE_MIN_PCT')) ?? LIMITES_SEMAFORO_PADRAO.verdeMinPct;
  const amareloMinPct = (await parametro(db, lojaId, 'SEMAFORO_AMARELO_MIN_PCT')) ?? LIMITES_SEMAFORO_PADRAO.amareloMinPct;
  return semaforoMargem(margemPct, { verdeMinPct, amareloMinPct }).cor;
}
