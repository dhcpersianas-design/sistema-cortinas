import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { d } from '@sistema/motor-calculo';
import { exigir } from '../auth/plugin.js';
import { pode } from '../auth/permissoes.js';
import { mensagemErro, textoOpcional } from '../cadastros/campos.js';
import { linkWhatsapp } from '../cadastros/validacao.js';
import {
  abrirAditivo, agendarInstalacao, aprovarOrcamento, atualizarOrdem, cancelarPedido, conferirSemAlteracao, confirmarAditivo,
  descartarAditivo, desmarcarInstalacao, ErroPedido, CATEGORIA_INSTALACAO, liberarCompras, listarOrdens, lerPedido, montarPedido,
  pedidoNoEscopo, registrarAceite, registrarNota, STATUS_PEDIDO,
} from '../pedidos/servico.js';
import { pdfOrdemCompra, pdfOrdemServico, pdfProducao, pdfTermoAceite } from '../pedidos/documentos.js';
import { lerDocumento } from '../orcamentos/servico.js';
import { BANDEIRAS, FORMAS_RECEBIMENTO } from '../financeiro/servico.js';

/**
 * Pedidos, compras, produção e instalação (especificação v1.1, seção 9 etapas 3 a 6).
 * VENDEDOR: os próprios pedidos (aprovar, conferir medidas, aditivo, OS e aceite na obra).
 * ADMIN: tudo, incluindo sinal, compras, ficha de corte, agenda, cancelamento e nota fiscal.
 */

const uuid = z.uuid();
const FORMAS = ['PIX', 'CREDITO_AVISTA', 'CREDITO_PARCELADO', 'DEBITO', 'BOLETO', 'DINHEIRO', 'MISTO'] as const;
const dinheiroTxt = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const t = String(v).trim();
  // Aceita 1.234,56 / 1234,56 / 1234.56
  const s = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) { ctx.addIssue({ code: 'custom', message: `Valor inválido: "${v}"` }); return z.NEVER; }
  return s;
});
const dataTxt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD).');
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function rotasPedidos(app: FastifyInstance) {
  const ver = { preHandler: exigir('pedidos.proprios') };
  const so = (perm: Parameters<typeof exigir>[0]) => ({ preHandler: exigir(perm) });

  function falhar(res: FastifyReply, e: unknown) {
    if (e instanceof ErroPedido) return res.code(e.status).send({ erro: e.message, ...e.extra });
    const pg = e as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === 'idx_aditivo_aberto') return res.code(409).send({ erro: 'Já existe um aditivo em aberto.' });
    if (pg.code === '23505' && pg.constraint === 'pedidos_grupo_orcamento_id_key') return res.code(409).send({ erro: 'Este projeto já virou pedido.' });
    throw e;
  }
  const idValido = (req: FastifyRequest<{ Params: { id: string } }>, res: FastifyReply) => {
    if (uuid.safeParse(req.params.id).success) return true;
    res.code(404).send({ erro: 'Pedido não encontrado.' });
    return false;
  };
  async function responder(req: FastifyRequest, id: string, extra: Record<string, unknown> = {}) {
    return { pedido: await montarPedido(app.db, req.usuario!, id), ...extra };
  }
  async function pedidoVisivel(req: FastifyRequest, id: string) {
    const p = await lerPedido(app.db, id);
    return p && pedidoNoEscopo(req.usuario!, p) ? p : null;
  }

  // ---------------------------------------------------------------- aprovação do orçamento
  app.post<{ Params: { id: string } }>('/api/orcamentos/:id/aprovar', so('orcamentos.proprios'), async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const corpo = z.object({
      formaPagamento: z.enum(FORMAS).nullish(),
      medidasConferidas: z.boolean().optional(),
      observacao: textoOpcional(200),
    }).safeParse(req.body ?? {});
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try {
      const r = await aprovarOrcamento(app.db, req.usuario!, req.params.id, { ...corpo.data, observacao: corpo.data.observacao ?? undefined });
      return res.code(201).send(await responder(req, r.id));
    } catch (e) { return falhar(res, e); }
  });

  // ---------------------------------------------------------------- lista
  app.get('/api/pedidos', ver, async (req, res) => {
    const f = z.object({
      q: z.string().trim().max(100).optional(),
      status: z.string().trim().max(30).optional(),
      limite: z.coerce.number().int().min(1).max(300).default(100),
    }).safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const u = req.usuario!;
    const { q, status, limite } = f.data;
    const like = q ? `%${q}%` : null;
    const abertos = status === 'ABERTOS';
    const { rows } = await app.db.execute(sql`
      SELECT p.id, p.numero_pedido AS numero, p.titulo, p.status_operacional AS status, c.nome_completo AS "clienteNome",
             u.nome AS "vendedorNome", p.valor_total_final AS "valorTotal", p.data_compra AS "dataCompra",
             to_char(p.data_previsao_entrega, 'YYYY-MM-DD') AS "previsaoEntrega", p.data_instalacao_agendada AS "instalacaoAgendada",
             p.data_instalacao_realizada AS "instalacaoRealizada",
             EXISTS (SELECT 1 FROM pedido_aditivos a WHERE a.pedido_id = p.id AND a.status = 'RASCUNHO') AS "aditivoAberto",
             (p.status_operacional = 'INSTALADO_CONCLUIDO' AND p.nfe_numero IS NULL AND p.nfse_numero IS NULL) AS "semNota",
             (p.data_previsao_entrega < CURRENT_DATE AND p.status_operacional NOT IN ('INSTALADO_CONCLUIDO', 'CANCELADO')) AS atrasado
        FROM pedidos p JOIN clientes c ON c.id = p.cliente_id JOIN usuarios u ON u.id = p.vendedor_id
       WHERE p.loja_id = ${u.lojaId}
         AND (${pode(u, 'pedidos.todos')}::boolean OR p.vendedor_id = ${u.id})
         AND (${abertos}::boolean IS FALSE OR p.status_operacional NOT IN ('INSTALADO_CONCLUIDO', 'CANCELADO'))
         AND (${abertos || !status ? null : status}::text IS NULL OR p.status_operacional::text = ${status ?? null})
         AND (${like}::text IS NULL OR f_busca(c.nome_completo || ' ' || p.numero_pedido || ' ' || COALESCE(p.titulo, '')) LIKE f_busca(${like}))
       ORDER BY p.data_compra DESC LIMIT ${limite}`);
    return { pedidos: rows, status: STATUS_PEDIDO };
  });

  app.get<{ Params: { id: string } }>('/api/pedidos/:id', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const pedido = await montarPedido(app.db, req.usuario!, req.params.id);
    if (!pedido) return res.code(404).send({ erro: 'Pedido não encontrado.' });
    return { pedido };
  });

  // ---------------------------------------------------------------- medição e aditivo
  app.post<{ Params: { id: string } }>('/api/pedidos/:id/conferir-medidas', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    try { await conferirSemAlteracao(app.db, req.usuario!, req.params.id); return await responder(req, req.params.id); }
    catch (e) { return falhar(res, e); }
  });

  app.post<{ Params: { id: string } }>('/api/pedidos/:id/aditivo', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({ motivo: textoOpcional(300) }).safeParse(req.body ?? {});
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try {
      const r = await abrirAditivo(app.db, req.usuario!, req.params.id, corpo.data.motivo);
      return res.code(r.jaAberto ? 200 : 201).send(await responder(req, req.params.id, r));
    } catch (e) { return falhar(res, e); }
  });

  app.post<{ Params: { id: string } }>('/api/pedidos/:id/aditivo/confirmar', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    try {
      const r = await confirmarAditivo(app.db, req.usuario!, req.params.id);
      return await responder(req, req.params.id, { resultado: r });
    } catch (e) { return falhar(res, e); }
  });

  app.post<{ Params: { id: string } }>('/api/pedidos/:id/aditivo/descartar', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    try { await descartarAditivo(app.db, req.usuario!, req.params.id); return await responder(req, req.params.id); }
    catch (e) { return falhar(res, e); }
  });

  // ---------------------------------------------------------------- sinal e compras (ADMIN)
  app.post<{ Params: { id: string } }>('/api/pedidos/:id/liberar-compras', so('financeiro.gerenciar'), async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.union([
      z.object({ semSinal: z.literal(true), motivo: textoOpcional(200) }),
      z.object({ valor: dinheiroTxt, forma: z.enum(FORMAS_RECEBIMENTO), recebidoEm: dataTxt, parcelas: z.coerce.number().int().min(1).max(24).optional(), bandeira: z.enum(BANDEIRAS).nullish() }),
    ]).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: 'Informe o valor, a forma e a data do sinal (ou libere sem sinal).' });
    try {
      const e = 'semSinal' in corpo.data ? { semSinal: true as const, motivo: corpo.data.motivo ?? undefined } : corpo.data;
      const r = await liberarCompras(app.db, req.usuario!, req.params.id, e);
      return await responder(req, req.params.id, r);
    } catch (e) { return falhar(res, e); }
  });

  app.get('/api/compras', so('compras.gerenciar'), async (req, res) => {
    const f = z.object({
      status: z.enum(['ABERTA', 'ENVIADA', 'RECEBIDA', 'CANCELADA']).optional(),
      fornecedorId: z.uuid().optional(),
    }).safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    return { ordens: await listarOrdens(app.db, req.usuario!.lojaId, f.data) };
  });

  app.post<{ Params: { id: string } }>('/api/compras/:id', so('compras.gerenciar'), async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Ordem de compra não encontrada.' });
    const corpo = z.object({
      acao: z.enum(['ENVIAR', 'RECEBER', 'CANCELAR', 'REABRIR', 'EDITAR']),
      fornecedorId: z.uuid().nullish(),
      previsaoEntrega: dataTxt.nullish(),
      custoReal: dinheiroTxt.nullish(),
      observacoes: textoOpcional(500),
    }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const c = corpo.data;
    const corpoBruto = (req.body ?? {}) as Record<string, unknown>;
    try {
      const r = await atualizarOrdem(app.db, req.usuario!, req.params.id, {
        acao: c.acao,
        // Só mexe no que veio no corpo (ausente = mantém).
        ...('fornecedorId' in corpoBruto ? { fornecedorId: c.fornecedorId ?? null } : {}),
        ...('previsaoEntrega' in corpoBruto ? { previsaoEntrega: c.previsaoEntrega ?? null } : {}),
        ...('custoReal' in corpoBruto ? { custoReal: c.custoReal ?? null } : {}),
        ...('observacoes' in corpoBruto ? { observacoes: c.observacoes } : {}),
      });
      return { ordens: await listarOrdens(app.db, req.usuario!.lojaId, { pedidoId: r.pedidoId }) };
    } catch (e) { return falhar(res, e); }
  });

  // ---------------------------------------------------------------- agenda de instalação
  app.post<{ Params: { id: string } }>('/api/pedidos/:id/agendar', so('instalacao.gerenciar'), async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({
      data: z.iso.datetime({ offset: true }),
      instaladorId: z.uuid(),
      duracaoHoras: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null || v === '' ? null : String(v).replace(',', '.'))),
      observacoes: textoOpcional(500),
    }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: 'Informe a data/hora e o instalador.' });
    if (corpo.data.duracaoHoras && !/^\d{1,2}(\.\d)?$/.test(corpo.data.duracaoHoras)) return res.code(400).send({ erro: 'Duração inválida (em horas).' });
    try { await agendarInstalacao(app.db, req.usuario!, req.params.id, corpo.data); return await responder(req, req.params.id); }
    catch (e) { return falhar(res, e); }
  });

  app.post<{ Params: { id: string } }>('/api/pedidos/:id/desmarcar', so('instalacao.gerenciar'), async (req, res) => {
    if (!idValido(req, res)) return;
    try { await desmarcarInstalacao(app.db, req.usuario!, req.params.id); return await responder(req, req.params.id); }
    catch (e) { return falhar(res, e); }
  });

  /** Agenda: instalações no período (vendedor vê as dele) e pedidos prontos ainda sem data. */
  app.get('/api/instalacoes', ver, async (req, res) => {
    const f = z.object({ de: dataTxt.optional(), ate: dataTxt.optional() }).safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const u = req.usuario!;
    const de = f.data.de ?? new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const ate = f.data.ate ?? new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    const escopo = sql`p.loja_id = ${u.lojaId} AND (${pode(u, 'pedidos.todos')}::boolean OR p.vendedor_id = ${u.id})`;
    const colunas = sql`p.id, p.numero_pedido AS numero, p.titulo, p.status_operacional AS status, c.nome_completo AS "clienteNome",
      c.telefone_whatsapp AS "clienteTelefone", CONCAT_WS(', ', NULLIF(CONCAT_WS(' ', c.logradouro, c.numero), ''), c.bairro, c.cidade) AS endereco,
      p.data_instalacao_agendada AS "instalacaoAgendada", p.instalacao_duracao_horas AS "duracaoHoras",
      f.nome_fantasia AS "instaladorNome", u.nome AS "vendedorNome", to_char(p.data_previsao_entrega, 'YYYY-MM-DD') AS "previsaoEntrega",
      (SELECT COUNT(*)::int FROM orcamento_itens_compostos i WHERE i.orcamento_id = p.orcamento_id) AS "qtdItens"`;
    const { rows: agenda } = await app.db.execute(sql`
      SELECT ${colunas} FROM pedidos p JOIN clientes c ON c.id = p.cliente_id JOIN usuarios u ON u.id = p.vendedor_id
        LEFT JOIN fornecedores f ON f.id = p.instalador_fornecedor_id
       WHERE ${escopo} AND p.data_instalacao_agendada >= ${de}::date AND p.data_instalacao_agendada < ${ate}::date + 1
         AND p.status_operacional <> 'CANCELADO'
       ORDER BY p.data_instalacao_agendada`);
    const { rows: semData } = await app.db.execute(sql`
      SELECT ${colunas} FROM pedidos p JOIN clientes c ON c.id = p.cliente_id JOIN usuarios u ON u.id = p.vendedor_id
        LEFT JOIN fornecedores f ON f.id = p.instalador_fornecedor_id
       WHERE ${escopo} AND p.data_instalacao_agendada IS NULL AND p.status_operacional IN ('PRONTO_ESTOQUE', 'EM_PRODUCAO', 'EM_COMPRA')
       ORDER BY (p.status_operacional = 'PRONTO_ESTOQUE') DESC, p.data_previsao_entrega NULLS LAST`);
    return { de, ate, agenda, semData };
  });

  /**
   * Pacote para a obra: instalações do vendedor (de ontem até 30 dias), com o que conferir e o
   * endereço. O aceite é feito no aparelho e enviado depois (POST /api/pedidos/:id/aceite).
   */
  app.get('/api/instalacoes/pacote-offline', ver, async (req) => {
    const u = req.usuario!;
    const { rows } = await app.db.execute<{ id: string }>(sql`
      SELECT p.id FROM pedidos p
       WHERE p.loja_id = ${u.lojaId} AND (${pode(u, 'pedidos.todos')}::boolean OR p.vendedor_id = ${u.id})
         AND p.data_instalacao_agendada IS NOT NULL
         AND p.data_instalacao_agendada >= CURRENT_DATE - 1 AND p.data_instalacao_agendada < CURRENT_DATE + 31
         AND p.status_operacional IN ('EM_COMPRA', 'EM_PRODUCAO', 'PRONTO_ESTOQUE', 'INSTALACAO_AGENDADA')
       ORDER BY p.data_instalacao_agendada LIMIT 60`);
    const instalacoes = [];
    const cats = (await app.db.execute(sql`SELECT sku, categoria_id AS c FROM produtos`)).rows as { sku: string; c: number }[];
    const cat = new Map(cats.map((x) => [x.sku, Number(x.c)]));
    for (const r of rows) {
      const p = (await lerPedido(app.db, r.id))!;
      const doc = (await lerDocumento(app.db, p.orcamentoId))!;
      instalacoes.push({
        id: p.id, numero: p.numero, titulo: p.titulo, status: p.status, statusNome: STATUS_PEDIDO[p.status],
        clienteNome: p.clienteNome, clienteTelefone: p.clienteTelefone, endereco: p.clienteEndereco, obsAcesso: p.clienteObsAcesso,
        instalacaoAgendada: p.instalacaoAgendada, instaladorNome: p.instaladorNome, obsInstalacao: p.obsInstalacao,
        saldo: d(p.valorTotal).minus(d(p.sinalValor ?? 0)).toFixed(2),
        itens: doc.itens.map((i) => ({
          id: i.id, ambiente: i.ambiente, tipo: i.tipo, descricao: i.descricaoComercial,
          medidas: `${d(i.larguraProducao).toFixed(2).replace('.', ',')} x ${d(i.alturaProducao).toFixed(2).replace('.', ',')} m`,
          pecas: i.componentes.filter((c) => ![CATEGORIA_INSTALACAO, 1, 5].includes(cat.get(c.sku) ?? 0))
            .map((c) => ({ sku: c.sku, descricao: c.descricao, quantidade: c.quantidade, unidade: c.unidade })),
        })),
      });
    }
    return { geradoEm: new Date().toISOString(), instalacoes };
  });

  // ---------------------------------------------------------------- aceite na obra
  app.post<{ Params: { id: string } }>('/api/pedidos/:id/aceite', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({
      id: z.uuid(),
      nomeRecebedor: z.string().trim().min(2, 'Informe o nome de quem recebeu').max(150),
      documentoRecebedor: textoOpcional(20),
      assinaturaPng: z.string().min(50).max(700_000),
      checklist: z.array(z.object({ itemId: z.string().max(60).nullish(), descricao: z.string().trim().min(1).max(300), ok: z.boolean() })).max(200),
      observacoes: textoOpcional(1000),
      assinadoEm: z.iso.datetime({ offset: true }),
      offline: z.boolean().optional(),
    }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    // Hora do aparelho: não aceita data no futuro (relógio errado).
    if (new Date(corpo.data.assinadoEm).getTime() > Date.now() + 10 * 60_000) {
      corpo.data.assinadoEm = new Date().toISOString();
    }
    try {
      const r = await registrarAceite(app.db, req.usuario!, req.params.id, corpo.data);
      return res.code(r.repetido ? 200 : 201).send(await responder(req, req.params.id, r));
    } catch (e) { return falhar(res, e); }
  });

  // ---------------------------------------------------------------- cancelamento e nota fiscal (ADMIN)
  app.post<{ Params: { id: string } }>('/api/pedidos/:id/cancelar', so('pedidos.todos'), async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({ motivo: z.string().trim().min(3, 'Informe o motivo do cancelamento').max(200) }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try { await cancelarPedido(app.db, req.usuario!, req.params.id, corpo.data.motivo); return await responder(req, req.params.id); }
    catch (e) { return falhar(res, e); }
  });

  app.post<{ Params: { id: string } }>('/api/pedidos/:id/nota-fiscal', so('financeiro.gerenciar'), async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({
      nfeNumero: textoOpcional(20),
      nfeChave: z.string().trim().nullish().transform((v, ctx) => {
        if (!v) return null;
        const s = v.replace(/\D/g, '');
        if (s.length !== 44) { ctx.addIssue({ code: 'custom', message: 'A chave da NF-e tem 44 dígitos.' }); return z.NEVER; }
        return s;
      }),
      nfseNumero: textoOpcional(20),
    }).safeParse(req.body ?? {});
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try { await registrarNota(app.db, req.usuario!, req.params.id, corpo.data); return await responder(req, req.params.id); }
    catch (e) { return falhar(res, e); }
  });

  // ---------------------------------------------------------------- PDFs
  function enviarPdf(res: FastifyReply, pdf: Buffer, nome: string) {
    return res.header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${nome}.pdf"`)
      .header('cache-control', 'no-store')
      .send(pdf);
  }

  app.get<{ Params: { id: string }; Querystring: { tipo?: string } }>('/api/pedidos/:id/producao.pdf', so('producao.gerenciar'), async (req, res) => {
    if (!idValido(req, res)) return;
    const p = await pedidoVisivel(req, req.params.id);
    if (!p) return res.code(404).send({ erro: 'Pedido não encontrado.' });
    const tipo = req.query.tipo === 'PERSIANA' ? 'PERSIANA' : 'CORTINA';
    const pdf = (await pdfProducao(app.db, p.id, tipo))!;
    return enviarPdf(res, pdf, `${tipo === 'CORTINA' ? 'ficha-corte' : 'pedido-fabrica'}-${p.numero}`);
  });

  app.get<{ Params: { id: string } }>('/api/pedidos/:id/os.pdf', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const p = await pedidoVisivel(req, req.params.id);
    if (!p) return res.code(404).send({ erro: 'Pedido não encontrado.' });
    return enviarPdf(res, (await pdfOrdemServico(app.db, p.id))!, `os-instalacao-${p.numero}`);
  });

  app.get<{ Params: { id: string } }>('/api/pedidos/:id/termo-aceite.pdf', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const p = await pedidoVisivel(req, req.params.id);
    if (!p) return res.code(404).send({ erro: 'Pedido não encontrado.' });
    const pdf = await pdfTermoAceite(app.db, p.id);
    if (!pdf) return res.code(404).send({ erro: 'Este pedido ainda não tem o aceite do cliente.' });
    return enviarPdf(res, pdf, `termo-aceite-${p.numero}`);
  });

  app.get<{ Params: { id: string } }>('/api/compras/:id/pdf', so('compras.gerenciar'), async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Ordem de compra não encontrada.' });
    const [o] = (await app.db.execute(sql`SELECT loja_id AS "lojaId" FROM ordens_compra WHERE id = ${req.params.id}`)).rows as { lojaId: string }[];
    if (!o || o.lojaId !== req.usuario!.lojaId) return res.code(404).send({ erro: 'Ordem de compra não encontrada.' });
    const r = (await pdfOrdemCompra(app.db, req.params.id))!;
    return enviarPdf(res, r.pdf, `ordem-compra-${r.numero}`);
  });

  /**
   * Link para mandar o PDF a quem não tem login (costureira, fábrica, fornecedor, instalador) pelo WhatsApp.
   * Vale 30 dias. Ficha de corte, pedido de fábrica e ordem de compra só o ADMIN gera; a OS, o vendedor também.
   */
  app.post<{ Params: { id: string } }>('/api/pedidos/:id/link-documento', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({
      tipo: z.enum(['FICHA_CORTE', 'PEDIDO_FABRICA', 'ORDEM_COMPRA', 'OS_INSTALACAO']),
      ordemCompraId: z.uuid().optional(),
      origem: z.url().optional(),
    }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const u = req.usuario!;
    const p = await pedidoVisivel(req, req.params.id);
    if (!p) return res.code(404).send({ erro: 'Pedido não encontrado.' });
    const { tipo, ordemCompraId, origem } = corpo.data;
    if (tipo !== 'OS_INSTALACAO' && !pode(u, 'compras.gerenciar')) return res.code(403).send({ erro: 'Seu perfil não tem acesso a esta função.' });
    let destino: string | null = p.instaladorWhatsapp;
    let nomeDoc = `a OS de instalação do pedido ${p.numero}`;
    if (tipo === 'ORDEM_COMPRA' || ((tipo === 'FICHA_CORTE' || tipo === 'PEDIDO_FABRICA') && ordemCompraId)) {
      if (!ordemCompraId) return res.code(400).send({ erro: 'Informe a ordem de compra.' });
      const [o] = (await app.db.execute(sql`SELECT o.numero, f.whatsapp FROM ordens_compra o LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
        WHERE o.id = ${ordemCompraId} AND o.pedido_id = ${p.id}`)).rows as { numero: string; whatsapp: string | null }[];
      if (!o) return res.code(404).send({ erro: 'Ordem de compra não encontrada.' });
      destino = o.whatsapp;
      nomeDoc = tipo === 'ORDEM_COMPRA' ? `a ordem ${o.numero}` : tipo === 'FICHA_CORTE' ? `a ficha de corte do pedido ${p.numero}` : `o pedido de fábrica ${p.numero}`;
    } else if (tipo !== 'OS_INSTALACAO') {
      destino = null;
      nomeDoc = tipo === 'FICHA_CORTE' ? `a ficha de corte do pedido ${p.numero}` : `o pedido de fábrica ${p.numero}`;
    }
    const token = randomBytes(24).toString('base64url');
    await app.db.execute(sql`
      INSERT INTO documentos_links_publicos (token_hash, tipo, pedido_id, ordem_compra_id, criado_por_id, expira_em)
      VALUES (${hashToken(token)}, ${tipo}, ${p.id}, ${tipo === 'ORDEM_COMPRA' ? ordemCompraId! : null}, ${u.id}, NOW() + INTERVAL '30 days')`);
    const caminho = `/api/documentos/${token}`;
    const url = origem ? new URL(caminho, origem).toString() : caminho;
    const msg = `Olá! Segue ${nomeDoc}: ${url}`;
    return res.code(201).send({ caminho, url, mensagem: msg, whatsapp: linkWhatsapp(destino, msg) ?? `https://wa.me/?text=${encodeURIComponent(msg)}` });
  });

  // Público (sem login): o terceiro abre o PDF pelo link.
  app.get<{ Params: { token: string } }>('/api/documentos/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, res) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(req.params.token)) return res.code(404).send({ erro: 'Link inválido.' });
    const { rows } = await app.db.execute<{ tipo: string; pedidoId: string; ordemId: string | null; numero: string }>(sql`
      UPDATE documentos_links_publicos l SET acessos = acessos + 1 FROM pedidos p
       WHERE l.token_hash = ${hashToken(req.params.token)} AND l.expira_em > NOW() AND p.id = l.pedido_id
      RETURNING l.tipo, l.pedido_id AS "pedidoId", l.ordem_compra_id AS "ordemId", p.numero_pedido AS numero`);
    const l = rows[0];
    if (!l) return res.code(404).send({ erro: 'Link vencido ou inválido. Peça um novo à loja.' });
    if (l.tipo === 'OS_INSTALACAO') return enviarPdf(res, (await pdfOrdemServico(app.db, l.pedidoId))!, `os-instalacao-${l.numero}`);
    if (l.tipo === 'ORDEM_COMPRA' && l.ordemId) {
      const r = await pdfOrdemCompra(app.db, l.ordemId);
      if (!r) return res.code(404).send({ erro: 'Documento não encontrado.' });
      return enviarPdf(res, r.pdf, `ordem-compra-${r.numero}`);
    }
    const tipo = l.tipo === 'PEDIDO_FABRICA' ? 'PERSIANA' : 'CORTINA';
    return enviarPdf(res, (await pdfProducao(app.db, l.pedidoId, tipo))!, `${tipo === 'CORTINA' ? 'ficha-corte' : 'pedido-fabrica'}-${l.numero}`);
  });
}
