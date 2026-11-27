import { d, dinheiro, type Decimal, type Numerico } from './decimal.js';

/** Markup padrão v1.1: 100% sobre o custo (venda = 2x custo). Parâmetro MARKUP_PADRAO_PCT. */
export const MARKUP_PADRAO_PCT = '100';

/** Preço de venda sugerido no cadastro/reajuste: custo x (1 + markup/100), 2 casas. O ADMIN pode alterar. */
export function precoVendaSugerido(custo: Numerico, markupPct: Numerico = MARKUP_PADRAO_PCT): Decimal {
  return dinheiro(d(custo).mul(d(markupPct).div(100).plus(1)));
}

export type CorSemaforo = 'VERDE' | 'AMARELO' | 'VERMELHO';

export interface LimitesSemaforo {
  /** SEMAFORO_VERDE_MIN_PCT (padrão 45). */
  verdeMinPct: Numerico;
  /** SEMAFORO_AMARELO_MIN_PCT (padrão 35). */
  amareloMinPct: Numerico;
}

export const LIMITES_SEMAFORO_PADRAO: LimitesSemaforo = { verdeMinPct: '45', amareloMinPct: '35' };

/** Semáforo da margem (%): verde >= 45; amarelo 35 a 44,99; vermelho < 35 (exige senha ADMIN). */
export function semaforoMargem(margemPct: Numerico, limites: LimitesSemaforo = LIMITES_SEMAFORO_PADRAO) {
  const m = d(margemPct);
  const cor: CorSemaforo = m.gte(d(limites.verdeMinPct)) ? 'VERDE' : m.gte(d(limites.amareloMinPct)) ? 'AMARELO' : 'VERMELHO';
  return { cor, exigeSenhaAdmin: cor === 'VERMELHO' };
}
