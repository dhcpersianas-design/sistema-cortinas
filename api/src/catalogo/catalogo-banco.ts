import { eq } from 'drizzle-orm';
import { aplicarPrecosBarra, criarCatalogo, type Catalogo, type LinhaPrecoBarra, type Produto } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { precosBarraTrilho, produtos } from '../db/schema.js';
import { carregarCategorias } from './categorias.js';

/**
 * Monta o `Catalogo` do motor de cálculo a partir do banco: produtos ativos +
 * tabela de preço por tamanho de barra. Reaproveita `aplicarPrecosBarra` do motor
 * (mesma regra da planilha: só cobra por barra quando os 6 tamanhos existem).
 */
export async function carregarCatalogoDoBanco(db: Banco): Promise<{ catalogo: Catalogo; avisos: string[]; skusComTabela: string[] }> {
  const linhasProdutos = await db.select().from(produtos).where(eq(produtos.ativo, true));
  const caminho = new Map((await carregarCategorias(db, null)).map((c) => [c.id, c.caminho]));
  const base: Produto[] = linhasProdutos.map((p) => ({
    categoria: caminho.get(p.categoriaId),
    disponibilidade: { status: p.disponibilidade, previsao: p.previsaoDisponivel },
    sku: p.sku,
    nome: p.nome,
    unidade: p.unidadeMedida,
    custoUnitario: p.custoUnitario,
    precoVendaUnitario: p.precoVendaUnitario,
    metadata: p.metadataTecnica,
  }));
  const barras = await db
    .select({ sku: produtos.sku, tamanhoM: precosBarraTrilho.tamanhoM, custo: precosBarraTrilho.custo, venda: precosBarraTrilho.venda })
    .from(precosBarraTrilho)
    .innerJoin(produtos, eq(produtos.id, precosBarraTrilho.produtoId));
  const linhas: LinhaPrecoBarra[] = barras.map((b) => ({ sku: b.sku, tamanhoM: String(b.tamanhoM), custo: b.custo, venda: b.venda }));
  const r = aplicarPrecosBarra(base, linhas);
  return { catalogo: criarCatalogo(r.produtos), avisos: r.avisos, skusComTabela: r.skusComTabela };
}
