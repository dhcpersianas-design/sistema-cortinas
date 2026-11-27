import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { categoriasProduto, produtos } from '../db/schema.js';
import { exigir } from '../auth/plugin.js';
import { pode } from '../auth/permissoes.js';

export async function rotasCatalogo(app: FastifyInstance) {
  app.get('/api/catalogo/produtos', { preHandler: exigir('catalogo.ver') }, async (req) => {
    const verCusto = pode(req.usuario!, 'custos.ver');
    const linhas = await app.db
      .select({
        id: produtos.id, sku: produtos.sku, nome: produtos.nome, categoria: categoriasProduto.nome,
        unidade: produtos.unidadeMedida, custoUnitario: produtos.custoUnitario,
        precoVendaUnitario: produtos.precoVendaUnitario, metadata: produtos.metadataTecnica,
      })
      .from(produtos)
      .innerJoin(categoriasProduto, eq(categoriasProduto.id, produtos.categoriaId))
      .where(eq(produtos.ativo, true))
      .orderBy(asc(categoriasProduto.ordemExibicao), asc(produtos.sku));
    return { produtos: verCusto ? linhas : linhas.map(({ custoUnitario: _, ...p }) => p) };
  });
}
