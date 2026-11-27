import type { FastifyInstance } from 'fastify';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { CATEGORIAS_FORNECEDOR, fornecedores, produtos } from '../db/schema.js';
import { exigir } from '../auth/plugin.js';
import {
  documentoOpcional, emailOpcional, endereco, mensagemErro, telefoneOpcional, termoLike, textoOpcional,
} from '../cadastros/campos.js';
import { formatarDocumento, formatarTelefone, linkWhatsapp, soDigitos } from '../cadastros/validacao.js';

/**
 * Fornecedores (só ADMIN). Inclui instaladores e costureiras terceirizados, que
 * não têm login (decisão do Gabriel): recebem a OS / ficha de corte em PDF e são
 * pagos como fornecedor. O pedido aponta para o instalador em
 * `pedidos.instalador_fornecedor_id`.
 */

const campos = {
  nomeFantasia: z.string().trim().min(2, 'Informe o nome').max(140),
  razaoSocial: textoOpcional(160),
  documento: documentoOpcional,
  categoria: z.enum(CATEGORIAS_FORNECEDOR, 'Categoria inválida'),
  telefone: telefoneOpcional,
  whatsapp: telefoneOpcional,
  email: emailOpcional,
  contatoNome: textoOpcional(120),
  prazoEntregaDias: z.coerce.number().int().min(0).max(365).nullish().transform((v) => v ?? 10),
  ...endereco,
  chavePix: textoOpcional(140),
  observacoes: textoOpcional(4000),
};
const corpoCriar = z.object(campos);
const corpoEditar = z.object({ ...campos, ativo: z.boolean() }).partial();

const filtros = z.object({
  q: z.string().trim().max(100).optional(),
  categoria: z.enum(CATEGORIAS_FORNECEDOR).optional(),
  inativos: z.enum(['0', '1']).optional(),
});

function publico(f: typeof fornecedores.$inferSelect) {
  const { nomeBusca: _b, ...resto } = f;
  return {
    ...resto,
    cnpjFormatado: formatarDocumento(f.cnpj),
    telefoneFormatado: formatarTelefone(f.telefone),
    whatsappFormatado: formatarTelefone(f.whatsapp),
    whatsappLink: linkWhatsapp(f.whatsapp ?? f.telefone),
  };
}

export async function rotasFornecedores(app: FastifyInstance) {
  const ver = { preHandler: exigir('fornecedores.ver') };
  const editar = { preHandler: exigir('fornecedores.editar') };

  app.get('/api/fornecedores', ver, async (req, res) => {
    const f = filtros.safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const cond: (SQL | undefined)[] = [];
    if (f.data.inativos !== '1') cond.push(eq(fornecedores.ativo, true));
    if (f.data.categoria) cond.push(eq(fornecedores.categoria, f.data.categoria));
    if (f.data.q) {
      const like = termoLike(f.data.q);
      const dig = soDigitos(f.data.q);
      const ou: SQL[] = [
        sql`${fornecedores.nomeBusca} LIKE f_busca(${like})`,
        sql`f_busca(COALESCE(${fornecedores.contatoNome}, '') || ' ' || COALESCE(${fornecedores.cidade}, '')) LIKE f_busca(${like})`,
      ];
      if (dig.length >= 4) {
        ou.push(sql`COALESCE(${fornecedores.cnpj}, '') LIKE ${dig + '%'}`);
        ou.push(sql`regexp_replace(COALESCE(${fornecedores.telefone}, '') || ' ' || COALESCE(${fornecedores.whatsapp}, ''), '\\D', '', 'g') LIKE ${'%' + dig + '%'}`);
      }
      cond.push(sql`(${sql.join(ou, sql` OR `)})`);
    }
    const linhas = await app.db.select().from(fornecedores).where(and(...cond))
      .orderBy(asc(fornecedores.categoria), asc(fornecedores.nomeBusca));
    return { fornecedores: linhas.map(publico) };
  });

  app.get<{ Params: { id: string } }>('/api/fornecedores/:id', ver, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Fornecedor não encontrado.' });
    const [f] = await app.db.select().from(fornecedores).where(eq(fornecedores.id, req.params.id));
    if (!f) return res.code(404).send({ erro: 'Fornecedor não encontrado.' });
    const itens = await app.db.select({ id: produtos.id, sku: produtos.sku, nome: produtos.nome, ativo: produtos.ativo })
      .from(produtos).where(eq(produtos.fornecedorPadraoId, f.id)).orderBy(asc(produtos.sku));
    return { fornecedor: publico(f), produtos: itens };
  });

  app.post('/api/fornecedores', editar, async (req, res) => {
    const corpo = corpoCriar.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const { documento, ...dados } = corpo.data;
    const [novo] = await app.db.insert(fornecedores).values({ ...dados, cnpj: documento?.digitos ?? null }).returning();
    return res.code(201).send({ fornecedor: publico(novo!) });
  });

  app.patch<{ Params: { id: string } }>('/api/fornecedores/:id', editar, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Fornecedor não encontrado.' });
    const corpo = corpoEditar.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const { documento, ...dados } = corpo.data;
    const mudancas: Partial<typeof fornecedores.$inferInsert> = { ...dados };
    if (documento !== undefined) mudancas.cnpj = documento?.digitos ?? null;
    if (Object.keys(mudancas).length === 0) return res.code(400).send({ erro: 'Nada para alterar.' });
    const [f] = await app.db.update(fornecedores).set({ ...mudancas, atualizadoEm: sql`NOW()` })
      .where(eq(fornecedores.id, req.params.id)).returning();
    if (!f) return res.code(404).send({ erro: 'Fornecedor não encontrado.' });
    return { fornecedor: publico(f) };
  });
}
