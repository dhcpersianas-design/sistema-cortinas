import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { clientes, usuarios } from '../db/schema.js';
import { exigir } from '../auth/plugin.js';
import { pode } from '../auth/permissoes.js';
import {
  documentoOpcional, emailOpcional, endereco, mensagemErro, telefoneObrigatorio, telefoneOpcional, termoLike, textoOpcional,
} from '../cadastros/campos.js';
import { formatarDocumento, formatarTelefone, linkWhatsapp, soDigitos } from '../cadastros/validacao.js';

/**
 * CRM de clientes (especificação v1.1, seção 10).
 * - VENDEDOR vê e edita só os clientes dos quais é responsável (decisão do Gabriel).
 *   Quem cadastra vira o responsável; só o ADMIN transfere ou inativa.
 * - Busca tolerante a acentos por nome, telefone, e-mail, CPF/CNPJ, bairro/cidade
 *   e produtos comprados (descrição dos itens dos pedidos).
 * - O app offline gera o UUID no aparelho: reenviar o mesmo POST não duplica.
 */

const camposCliente = {
  nomeCompleto: z.string().trim().min(2, 'Informe o nome completo').max(150),
  documento: documentoOpcional,
  telefoneWhatsapp: telefoneObrigatorio,
  telefoneSecundario: telefoneOpcional,
  email: emailOpcional,
  origemLead: textoOpcional(60),
  ...endereco,
  tipoImovel: textoOpcional(30),
  obsAcessoInstalacao: textoOpcional(2000),
  observacoes: textoOpcional(4000),
};

const corpoCriar = z.object({
  id: z.uuid().optional(),
  ...camposCliente,
  vendedorResponsavelId: z.uuid().optional(),
});

const corpoEditar = z.object({
  ...camposCliente,
  vendedorResponsavelId: z.uuid(),
  ativo: z.boolean(),
}).partial().extend({
  /** `atualizadoEm` que o aparelho tinha: se o cadastro mudou depois, devolve 409 em vez de sobrescrever. */
  atualizadoEmBase: z.iso.datetime({ offset: true }).optional(),
});

const filtrosLista = z.object({
  q: z.string().trim().max(100).optional(),
  inativos: z.enum(['0', '1']).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

const colunas = {
  cliente: clientes,
  vendedorNome: usuarios.nome,
};

function publico(l: { cliente: typeof clientes.$inferSelect; vendedorNome: string | null }) {
  const { nomeBusca: _b, lojaId: _l, cpfCnpj, ...c } = l.cliente;
  return {
    ...c,
    cpfCnpj,
    cpfCnpjFormatado: formatarDocumento(cpfCnpj),
    telefoneFormatado: formatarTelefone(c.telefoneWhatsapp),
    whatsappLink: linkWhatsapp(c.telefoneWhatsapp),
    vendedorResponsavelNome: l.vendedorNome,
  };
}
export type ClientePublico = ReturnType<typeof publico>;

export async function rotasClientes(app: FastifyInstance) {
  /** Restrição de escopo: VENDEDOR só enxerga os próprios clientes. */
  function escopo(req: FastifyRequest): SQL {
    const u = req.usuario!;
    const daLoja = eq(clientes.lojaId, u.lojaId);
    return pode(u, 'clientes.todos') ? daLoja : and(daLoja, eq(clientes.vendedorResponsavelId, u.id))!;
  }

  async function buscarUm(req: FastifyRequest, id: string) {
    const [l] = await app.db.select(colunas).from(clientes)
      .leftJoin(usuarios, eq(usuarios.id, clientes.vendedorResponsavelId))
      .where(and(eq(clientes.id, id), escopo(req)));
    return l ? publico(l) : null;
  }

  async function vendedorValido(lojaId: string, id: string) {
    const [v] = await app.db.select({ id: usuarios.id }).from(usuarios)
      .where(and(eq(usuarios.id, id), eq(usuarios.lojaId, lojaId), eq(usuarios.ativo, true)));
    return Boolean(v);
  }

  /** CPF/CNPJ já usado por outro cliente: mensagem sem expor dados de cliente de outro vendedor. */
  async function documentoEmUso(req: FastifyRequest, digitos: string, ignorarId?: string) {
    const [outro] = await app.db.select({ id: clientes.id, vendedor: clientes.vendedorResponsavelId }).from(clientes)
      .where(and(eq(clientes.cpfCnpj, digitos), ignorarId ? sql`${clientes.id} <> ${ignorarId}` : undefined));
    if (!outro) return null;
    const visivel = pode(req.usuario!, 'clientes.todos') || outro.vendedor === req.usuario!.id;
    return visivel
      ? { erro: 'Já existe cliente com este CPF/CNPJ.', clienteId: outro.id }
      : { erro: 'Este CPF/CNPJ já está cadastrado para outro vendedor. Peça ao administrador para transferir o cliente para você.' };
  }

  // ---------------------------------------------------------------- lista e busca
  app.get('/api/clientes', { preHandler: exigir('clientes.ver') }, async (req, res) => {
    const f = filtrosLista.safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const { q, inativos, limite } = f.data;
    const condicoes: (SQL | undefined)[] = [escopo(req)];
    if (inativos !== '1') condicoes.push(eq(clientes.ativo, true));
    let ordem: SQL = sql`${clientes.nomeBusca} ASC`;
    if (q) {
      const termo = sql`f_busca(${q})`;
      const like = termoLike(q);
      const digitos = soDigitos(q);
      const ou: SQL[] = [
        sql`${clientes.nomeBusca} LIKE f_busca(${like})`,
        sql`f_busca(COALESCE(${clientes.email}, '')) LIKE f_busca(${like})`,
        sql`f_busca(COALESCE(${clientes.bairro}, '') || ' ' || COALESCE(${clientes.cidade}, '')) LIKE f_busca(${like})`,
        // Produtos comprados: descrição comercial dos itens dos pedidos do cliente.
        sql`EXISTS (SELECT 1 FROM pedidos p JOIN orcamento_itens_compostos i ON i.orcamento_id = p.orcamento_id
             WHERE p.cliente_id = ${clientes.id} AND p.status_operacional <> 'CANCELADO'
               AND f_busca(i.descricao_comercial) LIKE f_busca(${like}))`,
      ];
      if (q.length >= 3) ou.push(sql`${clientes.nomeBusca} % ${termo}`); // erro de digitação (trigrama)
      if (digitos.length >= 4) {
        ou.push(sql`regexp_replace(${clientes.telefoneWhatsapp}, '\\D', '', 'g') LIKE ${'%' + digitos + '%'}`);
        ou.push(sql`regexp_replace(COALESCE(${clientes.telefoneSecundario}, ''), '\\D', '', 'g') LIKE ${'%' + digitos + '%'}`);
        ou.push(sql`${clientes.cpfCnpj} LIKE ${digitos + '%'}`);
      }
      condicoes.push(sql`(${sql.join(ou, sql` OR `)})`);
      ordem = sql`similarity(${clientes.nomeBusca}, ${termo}) DESC, ${clientes.nomeBusca} ASC`;
    }
    const linhas = await app.db.select(colunas).from(clientes)
      .leftJoin(usuarios, eq(usuarios.id, clientes.vendedorResponsavelId))
      .where(and(...condicoes)).orderBy(ordem).limit(limite);
    return { clientes: linhas.map(publico) };
  });

  /**
   * Pacote para uso offline: todos os clientes ativos do vendedor (ou da loja,
   * para o ADMIN), para busca e consulta no aparelho sem internet.
   */
  app.get('/api/clientes/pacote-offline', { preHandler: exigir('clientes.ver') }, async (req) => {
    const linhas = await app.db.select(colunas).from(clientes)
      .leftJoin(usuarios, eq(usuarios.id, clientes.vendedorResponsavelId))
      .where(and(escopo(req), eq(clientes.ativo, true))).orderBy(asc(clientes.nomeBusca));
    return { geradoEm: new Date().toISOString(), clientes: linhas.map(publico) };
  });

  // ---------------------------------------------------------------- ficha
  app.get<{ Params: { id: string } }>('/api/clientes/:id', { preHandler: exigir('clientes.ver') }, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Cliente não encontrado.' });
    const cliente = await buscarUm(req, req.params.id);
    if (!cliente) return res.code(404).send({ erro: 'Cliente não encontrado.' });

    // Histórico de compras e instalações: um pedido por linha (vw_clientes_historico_pesquisa).
    type LinhaPedido = {
      pedidoId: string; numeroPedido: string; dataCompra: string; dataInstalacao: string | null;
      formaPagamento: string | null; valorTotal: string; status: string; produtos: string | null;
    };
    const { rows: pedidos } = await app.db.execute<LinhaPedido>(sql`
      SELECT pedido_id AS "pedidoId", numero_pedido AS "numeroPedido", data_compra AS "dataCompra",
             data_instalacao AS "dataInstalacao", forma_pagamento AS "formaPagamento",
             valor_total_final AS "valorTotal", status_operacional AS "status", produtos_comprados AS "produtos"
        FROM vw_clientes_historico_pesquisa
       WHERE cliente_id = ${cliente.id} AND pedido_id IS NOT NULL
       ORDER BY data_compra DESC`);
    const veTodos = pode(req.usuario!, 'orcamentos.todos');
    const { rows: orcamentos } = await app.db.execute(sql`
      SELECT id, codigo_sequencial AS "codigo", versao, status, data_criacao AS "dataCriacao",
             valor_total_venda AS "valorTotal"
        FROM orcamentos
       WHERE cliente_id = ${cliente.id} AND (${veTodos}::boolean OR vendedor_id = ${req.usuario!.id})
       ORDER BY data_criacao DESC`);
    const instalacoes = pedidos.filter((p) => p.dataInstalacao).map((p) => ({
      pedidoId: p.pedidoId, numeroPedido: p.numeroPedido, dataInstalacao: p.dataInstalacao, produtos: p.produtos,
    }));
    return { cliente, historico: { pedidos, instalacoes, orcamentos } };
  });

  // ---------------------------------------------------------------- criar
  app.post('/api/clientes', { preHandler: exigir('clientes.editar') }, async (req, res) => {
    const corpo = corpoCriar.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const u = req.usuario!;
    const { id, documento, vendedorResponsavelId, ...dados } = corpo.data;

    // Reenvio do app offline (mesmo UUID): devolve o que já foi gravado.
    if (id) {
      const [existe] = await app.db.select({ id: clientes.id }).from(clientes).where(eq(clientes.id, id));
      if (existe) {
        const meu = await buscarUm(req, id);
        if (!meu) return res.code(409).send({ erro: 'Identificador já usado.' });
        return res.code(200).send({ cliente: meu, jaExistia: true, avisos: [] });
      }
    }

    let responsavel = u.id;
    if (vendedorResponsavelId && vendedorResponsavelId !== u.id) {
      if (!pode(u, 'clientes.todos')) return res.code(403).send({ erro: 'Só o administrador escolhe outro vendedor responsável.' });
      if (!(await vendedorValido(u.lojaId, vendedorResponsavelId))) return res.code(400).send({ erro: 'Vendedor responsável inválido.' });
      responsavel = vendedorResponsavelId;
    }
    if (documento) {
      const uso = await documentoEmUso(req, documento.digitos);
      if (uso) return res.code(409).send(uso);
    }
    const [novo] = await app.db.insert(clientes).values({
      ...(id ? { id } : {}),
      ...dados,
      cpfCnpj: documento?.digitos ?? null,
      tipoPessoa: documento?.tipo ?? 'PF',
      lojaId: u.lojaId,
      vendedorResponsavelId: responsavel,
      criadoPorId: u.id,
      atualizadoEm: sql`date_trunc('milliseconds', NOW())`,
    }).returning({ id: clientes.id });
    const cliente = (await buscarUm(req, novo!.id))!;
    return res.code(201).send({ cliente, jaExistia: false, avisos: await avisosTelefone(req, cliente) });
  });

  /** Aviso (não bloqueia): outro cliente visível com o mesmo WhatsApp, possível duplicado. */
  async function avisosTelefone(req: FastifyRequest, c: ClientePublico): Promise<string[]> {
    const outros = await app.db.select({ nome: clientes.nomeCompleto }).from(clientes)
      .where(and(escopo(req), eq(clientes.telefoneWhatsapp, c.telefoneWhatsapp), sql`${clientes.id} <> ${c.id}`)).limit(3);
    return outros.length ? [`Mesmo WhatsApp de: ${outros.map((o) => o.nome).join(', ')}. Confira se não é cadastro duplicado.`] : [];
  }

  // ---------------------------------------------------------------- editar
  app.patch<{ Params: { id: string } }>('/api/clientes/:id', { preHandler: exigir('clientes.editar') }, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Cliente não encontrado.' });
    const corpo = corpoEditar.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const u = req.usuario!;
    const atual = await buscarUm(req, req.params.id);
    if (!atual) return res.code(404).send({ erro: 'Cliente não encontrado.' });

    const { atualizadoEmBase, documento, vendedorResponsavelId, ativo, ...campos } = corpo.data;
    if ((vendedorResponsavelId !== undefined && vendedorResponsavelId !== atual.vendedorResponsavelId) || ativo !== undefined) {
      if (!pode(u, 'clientes.todos')) return res.code(403).send({ erro: 'Só o administrador transfere ou inativa clientes.' });
    }
    if (vendedorResponsavelId && !(await vendedorValido(u.lojaId, vendedorResponsavelId))) {
      return res.code(400).send({ erro: 'Vendedor responsável inválido.' });
    }
    const mudancas: Partial<typeof clientes.$inferInsert> = { ...campos };
    if (vendedorResponsavelId !== undefined) mudancas.vendedorResponsavelId = vendedorResponsavelId;
    if (ativo !== undefined) mudancas.ativo = ativo;
    if (documento !== undefined) {
      if (documento) {
        const uso = await documentoEmUso(req, documento.digitos, atual.id);
        if (uso) return res.code(409).send(uso);
      }
      mudancas.cpfCnpj = documento?.digitos ?? null;
      if (documento) mudancas.tipoPessoa = documento.tipo;
    }
    if (Object.keys(mudancas).length === 0) return res.code(400).send({ erro: 'Nada para alterar.' });

    const condicao = atualizadoEmBase
      ? and(eq(clientes.id, atual.id), sql`date_trunc('milliseconds', ${clientes.atualizadoEm}) = ${atualizadoEmBase}::timestamptz`)
      : eq(clientes.id, atual.id);
    const feitos = await app.db.update(clientes)
      .set({ ...mudancas, atualizadoEm: sql`date_trunc('milliseconds', NOW())` })
      .where(condicao).returning({ id: clientes.id });
    if (feitos.length === 0) {
      // Editado em outro aparelho depois que este baixou: não sobrescreve.
      return res.code(409).send({
        erro: 'Este cliente foi alterado em outro lugar depois que você abriu. Confira os dados atuais e refaça a alteração.',
        conflito: true, cliente: atual,
      });
    }
    const cliente = await buscarUm(req, atual.id);
    return { cliente, avisos: cliente ? await avisosTelefone(req, cliente) : [] };
  });

  // Lista curta de vendedores ativos para o ADMIN escolher o responsável.
  app.get('/api/clientes-vendedores', { preHandler: exigir('clientes.todos') }, async (req) => ({
    vendedores: await app.db.select({ id: usuarios.id, nome: usuarios.nome, perfil: usuarios.perfil }).from(usuarios)
      .where(and(eq(usuarios.lojaId, req.usuario!.lojaId), eq(usuarios.ativo, true))).orderBy(asc(usuarios.nome)),
  }));
}
