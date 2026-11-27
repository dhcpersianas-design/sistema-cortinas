import { asc } from 'drizzle-orm';
import { MARKUP_PADRAO_PCT } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { categoriasProduto } from '../db/schema.js';
import { parametro } from './parametros.js';

/**
 * Árvore de categorias do catálogo (pedido do Gabriel, 27/11/2026):
 * 4 principais (Persianas, Tecidos, Acessórios Persianas, Acessórios Cortinas) + Serviços,
 * com subcategorias. Produto fica sempre numa categoria "final" (sem subcategorias).
 *
 * Markup por categoria: vale o da própria categoria; vazio = o da categoria de cima;
 * nenhuma tem = parâmetro MARKUP_PADRAO_PCT (100%).
 */

export const ID_TRILHOS = 2;
export const ID_INSTALACAO = 9;

export interface CategoriaArvore {
  id: number;
  nome: string;
  paiId: number | null;
  /** Categoria principal (topo da árvore). */
  principalId: number;
  principal: string;
  /** "Persianas › Rolo › Double Vision". */
  caminho: string;
  perfil: string;
  nivel: number;
  ordem: number;
  /** Markup próprio (null = herda). */
  markupPct: string | null;
  /** Markup que vale de fato para os produtos desta categoria. */
  markupEfetivo: string;
  /** De onde vem o markup efetivo (nome da categoria, ou "padrão"). */
  markupOrigem: string;
  temSubcategorias: boolean;
  trilho: boolean;
}

type Exec = Pick<Banco, 'select'>;

/** `lojaId` null = sem consultar o parâmetro de markup padrão (usa 100%). */
export async function carregarCategorias(db: Exec, lojaId: string | null): Promise<CategoriaArvore[]> {
  const linhas = await db.select().from(categoriasProduto).orderBy(asc(categoriasProduto.ordemExibicao), asc(categoriasProduto.id));
  const padrao = (lojaId ? await parametro(db as Banco, lojaId, 'MARKUP_PADRAO_PCT') : null) ?? MARKUP_PADRAO_PCT;
  const porId = new Map(linhas.map((c) => [c.id, c]));
  const comFilhas = new Set(linhas.map((c) => c.paiId).filter((x): x is number => x != null));
  const resultado: CategoriaArvore[] = [];
  for (const c of linhas) {
    const cadeia = [c];
    for (let p = c.paiId != null ? porId.get(c.paiId) : undefined; p && cadeia.length < 10; p = p.paiId != null ? porId.get(p.paiId) : undefined) cadeia.unshift(p);
    const comMarkup = [...cadeia].reverse().find((x) => x.markupPct != null);
    resultado.push({
      id: c.id, nome: c.nome, paiId: c.paiId ?? null,
      principalId: cadeia[0]!.id, principal: cadeia[0]!.nome,
      caminho: cadeia.map((x) => x.nome).join(' › '),
      perfil: c.perfil, nivel: cadeia.length - 1, ordem: c.ordemExibicao ?? 0,
      markupPct: c.markupPct ?? null,
      markupEfetivo: String(Number(comMarkup?.markupPct ?? padrao)),
      markupOrigem: comMarkup ? comMarkup.nome : 'padrão',
      temSubcategorias: comFilhas.has(c.id),
      trilho: c.perfil === 'TRILHO',
    });
  }
  // Ordem da árvore: cada categoria logo depois da de cima.
  const filhas = (pai: number | null) => resultado.filter((c) => c.paiId === pai).sort((a, b) => a.ordem - b.ordem || a.id - b.id);
  const ordenada: CategoriaArvore[] = [];
  const visitar = (pai: number | null) => { for (const c of filhas(pai)) { ordenada.push(c); visitar(c.id); } };
  visitar(null);
  return ordenada;
}

/** Markup que vale para um produto desta categoria. */
export function markupDe(categorias: CategoriaArvore[], categoriaId: number, padrao: string = MARKUP_PADRAO_PCT): string {
  return categorias.find((c) => c.id === categoriaId)?.markupEfetivo ?? padrao;
}

/** Erro ao colocar um produto nesta categoria (só categoria final aceita produto novo). */
export function erroCategoriaProduto(categorias: CategoriaArvore[], categoriaId: number): string | null {
  const c = categorias.find((x) => x.id === categoriaId);
  if (!c) return 'Categoria inválida.';
  if (c.temSubcategorias) return `Escolha a subcategoria de ${c.caminho}.`;
  return null;
}
