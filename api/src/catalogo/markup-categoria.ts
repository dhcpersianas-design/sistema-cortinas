import { eq, inArray, sql } from 'drizzle-orm';
import { d, precoVendaSugerido } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { categoriasProduto, historicoPrecosProduto, precosBarraTrilho, produtos } from '../db/schema.js';
import type { CategoriaArvore } from './categorias.js';

/**
 * Mudar o markup de uma subcategoria RECALCULA a venda de todos os produtos dela
 * (Gabriel, 27/11/2026): venda = custo × (1 + markup). No trilho, também a tabela de barras.
 * Só vale para categoria final (sem subcategorias): não dá para mudar "Persianas" inteira.
 * Toda mudança de preço vai para o histórico, com o motivo.
 */

type Tx = Parameters<Parameters<Banco['transaction']>[0]>[0];
type Exec = Banco | Tx;

export interface LinhaMarkup {
  produtoId: string; sku: string; nome: string; tamanhoM: number | null; ativo: boolean;
  custo: string; vendaAntes: string; vendaDepois: string;
}
export interface PreviaMarkup {
  categoriaId: number; caminho: string;
  markupAntes: string; markupDepois: string;
  /** Linhas cujo preço de venda muda (produto ou barra do trilho). */
  linhas: LinhaMarkup[];
  /** Quantos preços mudam. Mais de 10 pede confirmação (ALTERAR). */
  afetados: number;
  produtosNaCategoria: number;
}

/** Erro se a categoria não pode ter o markup mudado. */
export function erroMarkupCategoria(c: CategoriaArvore | undefined): string | null {
  if (!c) return 'Categoria não encontrada.';
  if (c.temSubcategorias) {
    return `Escolha uma subcategoria de ${c.caminho} para mudar o markup (ex.: ${c.caminho.startsWith('Persianas') ? 'Horizontal, Vertical' : 'uma das de dentro'}).`;
  }
  return null;
}

export async function previaMarkup(db: Exec, cats: CategoriaArvore[], c: CategoriaArvore, novoPct: string | null): Promise<PreviaMarkup> {
  const pai = cats.find((x) => x.id === c.paiId);
  const depois = novoPct ?? pai?.markupEfetivo ?? c.markupEfetivo;
  const lista = await db.select().from(produtos).where(eq(produtos.categoriaId, c.id));
  const linhas: LinhaMarkup[] = [];
  for (const p of lista) {
    const v = precoVendaSugerido(p.custoUnitario, depois).toFixed(4);
    if (!d(v).eq(d(p.precoVendaUnitario))) {
      linhas.push({ produtoId: p.id, sku: p.sku, nome: p.nome, tamanhoM: null, ativo: p.ativo !== false, custo: p.custoUnitario, vendaAntes: p.precoVendaUnitario, vendaDepois: v });
    }
  }
  if (c.trilho && lista.length) {
    const barras = await db.select().from(precosBarraTrilho).where(inArray(precosBarraTrilho.produtoId, lista.map((p) => p.id)));
    for (const b of barras) {
      const v = precoVendaSugerido(b.custo, depois).toFixed(4);
      if (d(v).eq(d(b.venda))) continue;
      const p = lista.find((x) => x.id === b.produtoId)!;
      linhas.push({ produtoId: p.id, sku: p.sku, nome: p.nome, tamanhoM: b.tamanhoM, ativo: p.ativo !== false, custo: b.custo, vendaAntes: b.venda, vendaDepois: v });
    }
  }
  linhas.sort((a, b) => a.sku.localeCompare(b.sku) || (a.tamanhoM ?? 0) - (b.tamanhoM ?? 0));
  return {
    categoriaId: c.id, caminho: c.caminho, markupAntes: c.markupEfetivo, markupDepois: String(Number(depois)),
    linhas, afetados: linhas.length, produtosNaCategoria: lista.length,
  };
}

/** Grava o markup e os preços novos (na transação de quem chama). */
export async function aplicarMarkup(tx: Tx, previa: PreviaMarkup, novoPct: string | null, usuarioId: string) {
  await tx.update(categoriasProduto).set({ markupPct: novoPct }).where(eq(categoriasProduto.id, previa.categoriaId));
  const motivo = `Markup de ${previa.caminho}: ${Number(previa.markupAntes)}% → ${Number(previa.markupDepois)}%`.slice(0, 200);
  for (const l of previa.linhas) {
    if (l.tamanhoM === null) {
      await tx.update(produtos).set({ precoVendaUnitario: l.vendaDepois, atualizadoEm: sql`NOW()` }).where(eq(produtos.id, l.produtoId));
    } else {
      await tx.update(precosBarraTrilho).set({ venda: l.vendaDepois, atualizadoEm: sql`NOW()` })
        .where(sql`${precosBarraTrilho.produtoId} = ${l.produtoId} AND ${precosBarraTrilho.tamanhoM} = ${l.tamanhoM}`);
    }
    await tx.insert(historicoPrecosProduto).values({
      produtoId: l.produtoId, tamanhoM: l.tamanhoM, custoAnterior: l.custo, custoNovo: l.custo,
      vendaAnterior: l.vendaAntes, vendaNova: l.vendaDepois, alteradoPor: usuarioId, motivo,
    });
  }
}
