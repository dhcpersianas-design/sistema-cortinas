import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { Decimal } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { parametrosSistema } from '../db/schema.js';

/** Valor vigente hoje de um parâmetro (maior `vigente_desde` <= hoje). */
export async function parametro(db: Banco, lojaId: string, chave: string): Promise<string | null> {
  const [l] = await db.select({ valor: parametrosSistema.valor }).from(parametrosSistema)
    .where(and(eq(parametrosSistema.lojaId, lojaId), eq(parametrosSistema.chave, chave), lte(parametrosSistema.vigenteDesde, sql`CURRENT_DATE`)))
    .orderBy(desc(parametrosSistema.vigenteDesde)).limit(1);
  return l?.valor ?? null;
}

export type CorSemaforo = 'VERDE' | 'AMARELO' | 'VERMELHO';

/** Semáforo de margem (decisão 6): verde >= 45%, amarelo >= 35%, vermelho abaixo. */
export async function semaforo(db: Banco, lojaId: string, margemPct: string): Promise<CorSemaforo> {
  const verde = new Decimal((await parametro(db, lojaId, 'SEMAFORO_VERDE_MIN_PCT')) ?? '45');
  const amarelo = new Decimal((await parametro(db, lojaId, 'SEMAFORO_AMARELO_MIN_PCT')) ?? '35');
  const m = new Decimal(margemPct);
  if (m.gte(verde)) return 'VERDE';
  if (m.gte(amarelo)) return 'AMARELO';
  return 'VERMELHO';
}
