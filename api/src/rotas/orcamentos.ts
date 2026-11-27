import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { exigir } from '../auth/plugin.js';
import { pode } from '../auth/permissoes.js';
import { conferirSenha, HASH_FALSO } from '../auth/senha.js';
import { mensagemErro } from '../cadastros/campos.js';
import { linkWhatsapp } from '../cadastros/validacao.js';
import { parametro } from '../catalogo/parametros.js';
import { documentoEntrada } from '../orcamentos/esquemas.js';
import {
  documentoPublico, ErroOrcamento, lerCabecalho, lerDocumento, liberar, mudarStatus, noEscopo, novaVersao,
  parametrosMargem, salvarDocumento, TRANSICOES,
} from '../orcamentos/servico.js';
import { dinheiroBR, gerarPdf, montarProposta } from '../orcamentos/proposta.js';

/**
 * Orçamentos (configurador por ambiente) e proposta em PDF.
 * VENDEDOR: só os próprios orçamentos, sem custo/margem (a menos que tenha "pode ver custos").
 * O app grava o orçamento inteiro com PUT /api/orcamentos/:id (online ou ao sincronizar a fila
 * offline); o servidor recalcula, rateia, aplica a trava de margem e audita.
 */

const uuid = z.uuid();
const filtros = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().trim().max(30).optional(),
  clienteId: z.uuid().optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function rotasOrcamentos(app: FastifyInstance) {
  const ver = { preHandler: exigir('orcamentos.proprios') };

  function falhar(res: FastifyReply, e: unknown) {
    if (e instanceof ErroOrcamento) return res.code(e.status).send({ erro: e.message, ...e.extra });
    throw e;
  }

  async function documento(req: FastifyRequest, id: string) {
    const doc = await lerDocumento(app.db, id);
    if (!doc || !noEscopo(req.usuario!, doc.c)) return null;
    return documentoPublico(req.usuario!, doc);
  }

  // ---------------------------------------------------------------- lista
  app.get('/api/orcamentos', ver, async (req, res) => {
    const f = filtros.safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const u = req.usuario!;
    const { q, status, clienteId, limite } = f.data;
    const like = q ? `%${q}%` : null;
    const { rows } = await app.db.execute(sql`
      SELECT o.id, o.codigo_sequencial AS codigo, o.versao, o.status, o.titulo, o.cliente_id AS "clienteId",
             c.nome_completo AS "clienteNome", u.nome AS "vendedorNome", o.valor_total_venda AS total, o.semaforo,
             o.data_criacao AS "dataCriacao", o.atualizado_em AS "atualizadoEm", to_char(o.validade_ate, 'YYYY-MM-DD') AS "validadeAte",
             (SELECT COUNT(*)::int FROM orcamento_itens_compostos i WHERE i.orcamento_id = o.id) AS "qtdItens"
        FROM orcamentos o
        JOIN clientes c ON c.id = o.cliente_id
        JOIN usuarios u ON u.id = o.vendedor_id
       WHERE o.loja_id = ${u.lojaId}
         AND (${pode(u, 'orcamentos.todos')}::boolean OR o.vendedor_id = ${u.id})
         AND o.versao = (SELECT MAX(versao) FROM orcamentos x WHERE x.grupo_id = o.grupo_id)
         AND (${status ?? null}::text IS NULL OR o.status::text = ${status ?? null})
         AND (${clienteId ?? null}::uuid IS NULL OR o.cliente_id = ${clienteId ?? null})
         AND (${like}::text IS NULL OR f_busca(c.nome_completo || ' ' || o.codigo_sequencial || ' ' || COALESCE(o.titulo, '')) LIKE f_busca(${like}))
       ORDER BY o.atualizado_em DESC LIMIT ${limite}`);
    return { orcamentos: rows };
  });

  /**
   * Pacote para a obra: orçamentos abertos do vendedor (versão mais nova) e os parâmetros que
   * o aparelho usa para calcular sem internet. O cálculo do aparelho é provisório.
   */
  app.get('/api/orcamentos/pacote-offline', ver, async (req) => {
    const u = req.usuario!;
    const { rows } = await app.db.execute<{ id: string }>(sql`
      SELECT o.id FROM orcamentos o
       WHERE o.loja_id = ${u.lojaId} AND (${pode(u, 'orcamentos.todos')}::boolean OR o.vendedor_id = ${u.id})
         AND o.status NOT IN ('APROVADO', 'PERDIDO', 'EXPIRADO')
         AND o.versao = (SELECT MAX(versao) FROM orcamentos x WHERE x.grupo_id = o.grupo_id)
       ORDER BY o.atualizado_em DESC LIMIT 100`);
    const orcamentos = [];
    for (const r of rows) { const doc = await documento(req, r.id); if (doc) orcamentos.push(doc); }
    const p = await parametrosMargem(app.db, u.lojaId, u.id, null, 1);
    const { rows: taxas } = await app.db.execute(sql`
      SELECT forma_pagamento AS forma, parcelas, (taxa_mdr_pct + taxa_antecip_pct)::text AS "taxaPct" FROM taxas_pagamento`);
    return {
      geradoEm: new Date().toISOString(),
      orcamentos,
      parametros: {
        limites: p.limites, aliquotaImpostoPct: p.aliquotaImpostoPct, comissaoPct: p.comissaoPct, descontoMaxPct: p.descontoMaxPct,
        taxas, validadeDias: (await parametro(app.db, u.lojaId, 'VALIDADE_ORCAMENTO_DIAS')) ?? '15',
      },
    };
  });

  // ---------------------------------------------------------------- um orçamento
  app.get<{ Params: { id: string } }>('/api/orcamentos/:id', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const doc = await documento(req, req.params.id);
    if (!doc) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const transicoes = doc.versaoMaisNovaId === doc.id && !doc.aditivo ? TRANSICOES[doc.status] ?? [] : [];
    return { orcamento: doc, transicoes, podeAprovar: transicoes.includes('PERDIDO') && doc.status !== 'RASCUNHO' && !doc.pedidoId };
  });

  /** Cria ou grava o orçamento inteiro (é também a sincronização do que foi feito offline). */
  app.put<{ Params: { id: string } }>('/api/orcamentos/:id', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(400).send({ erro: 'Identificador inválido.' });
    const corpo = documentoEntrada.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try {
      const r = await salvarDocumento(app.db, req.usuario!, req.params.id, corpo.data);
      const doc = await documento(req, r.id);
      return res.code(r.novaVersao ? 201 : 200).send({ orcamento: doc, ...r });
    } catch (e) { return falhar(res, e); }
  });

  app.get<{ Params: { id: string } }>('/api/orcamentos/:id/versoes', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const c = await lerCabecalho(app.db, req.params.id);
    if (!c || !noEscopo(req.usuario!, c)) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const { rows } = await app.db.execute(sql`
      SELECT id, versao, status, valor_total_venda AS total, semaforo, data_criacao AS "dataCriacao",
             enviado_em AS "enviadoEm", congelado_em AS "congeladoEm"
        FROM orcamentos WHERE grupo_id = ${c.grupoId} ORDER BY versao DESC`);
    return { versoes: rows };
  });

  app.get<{ Params: { id: string } }>('/api/orcamentos/:id/auditoria', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const c = await lerCabecalho(app.db, req.params.id);
    if (!c || !noEscopo(req.usuario!, c)) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const verCusto = pode(req.usuario!, 'custos.ver');
    const { rows } = await app.db.execute<{ acao: string; descricao: string }>(sql`
      SELECT a.id, o.versao, a.acao, a.descricao, a.offline, a.criado_em AS "criadoEm", u.nome AS usuario
        FROM orcamento_auditoria a JOIN orcamentos o ON o.id = a.orcamento_id LEFT JOIN usuarios u ON u.id = a.usuario_id
       WHERE o.grupo_id = ${c.grupoId} ORDER BY a.criado_em DESC, a.id LIMIT 500`);
    // A liberação cita a margem: quem não vê custo vê só que foi liberado.
    return { eventos: rows.map((r) => (!verCusto && r.acao === 'LIBERACAO_MARGEM' ? { ...r, descricao: 'Liberado pelo administrador.' } : r)) };
  });

  app.post<{ Params: { id: string } }>('/api/orcamentos/:id/nova-versao', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const corpo = z.object({ atualizarPrecos: z.boolean().default(false) }).safeParse(req.body ?? {});
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try {
      const id = await novaVersao(app.db, req.usuario!, req.params.id, corpo.data.atualizarPrecos);
      return res.code(201).send({ orcamento: await documento(req, id) });
    } catch (e) { return falhar(res, e); }
  });

  app.post<{ Params: { id: string } }>('/api/orcamentos/:id/status', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const corpo = z.object({
      status: z.enum(['ENVIADO', 'AGUARDANDO_MEDICAO', 'EM_NEGOCIACAO', 'PERDIDO']),
      motivoPerda: z.string().trim().max(120).optional(),
    }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try {
      await mudarStatus(app.db, req.usuario!, req.params.id, corpo.data.status, corpo.data.motivoPerda);
      return { orcamento: await documento(req, req.params.id) };
    } catch (e) { return falhar(res, e); }
  });

  /**
   * Liberação da trava de margem/desconto. O ADMIN logado libera direto; no aparelho do
   * vendedor, o ADMIN digita o e-mail e a senha dele (só com internet).
   */
  app.post<{ Params: { id: string } }>('/api/orcamentos/:id/liberar', {
    ...ver, config: { rateLimit: { max: app.config.limiteLoginPorMinuto, timeWindow: '1 minute' } },
  }, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const u = req.usuario!;
    let adminId = u.id;
    if (!pode(u, 'margem.liberar_vermelho')) {
      const corpo = z.object({ email: z.string().trim().toLowerCase().email(), senha: z.string().min(1).max(200) }).safeParse(req.body);
      if (!corpo.success) return res.code(400).send({ erro: 'Informe o e-mail e a senha do administrador.' });
      const { rows } = await app.db.execute<{ id: string; senhaHash: string; perfil: string; ativo: boolean; lojaId: string }>(sql`
        SELECT id, senha_hash AS "senhaHash", perfil, ativo, loja_id AS "lojaId" FROM usuarios WHERE email = ${corpo.data.email}`);
      const a = rows[0];
      const ok = await conferirSenha(corpo.data.senha, a?.senhaHash ?? HASH_FALSO);
      if (!a || !ok || !a.ativo || a.perfil !== 'ADMIN' || a.lojaId !== u.lojaId) {
        return res.code(403).send({ erro: 'E-mail ou senha de administrador incorretos.' });
      }
      adminId = a.id;
    }
    try {
      await liberar(app.db, u, req.params.id, adminId);
      return { orcamento: await documento(req, req.params.id) };
    } catch (e) { return falhar(res, e); }
  });

  // ---------------------------------------------------------------- proposta (PDF)
  async function enviarPdf(res: FastifyReply, id: string, detalhar: boolean, nomeArquivo: string) {
    const dados = await montarProposta(app.db, id, detalhar);
    if (!dados) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const pdf = await gerarPdf(dados);
    return res.header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${nomeArquivo}.pdf"`)
      .header('cache-control', 'no-store')
      .send(pdf);
  }

  app.get<{ Params: { id: string }; Querystring: { detalhar?: string } }>('/api/orcamentos/:id/proposta.pdf', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const doc = await documento(req, req.params.id);
    if (!doc) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    if (doc.liberacao.pendente) return res.code(409).send({ erro: 'Precisa da senha do administrador antes de gerar a proposta.', exigeLiberacao: true });
    return enviarPdf(res, doc.id, req.query.detalhar === '1', `proposta-${doc.codigo}-v${doc.versao}`);
  });

  /**
   * Link público do PDF para o WhatsApp (12.5). Só para versão enviada (congelada): o cliente
   * nunca vê um rascunho que ainda vai mudar. Vale até a validade do orçamento.
   */
  app.post<{ Params: { id: string } }>('/api/orcamentos/:id/link-publico', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const corpo = z.object({ detalhar: z.boolean().default(false), origem: z.url().optional() }).safeParse(req.body ?? {});
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const doc = await documento(req, req.params.id);
    if (!doc) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    if (doc.status === 'RASCUNHO') return res.code(409).send({ erro: 'Envie a proposta (congela a versão) antes de gerar o link para o cliente.' });
    const token = randomBytes(24).toString('base64url');
    await app.db.execute(sql`
      INSERT INTO orcamento_links_publicos (token_hash, orcamento_id, detalhar, criado_por_id, expira_em)
      VALUES (${hashToken(token)}, ${doc.id}, ${corpo.data.detalhar}, ${req.usuario!.id},
        GREATEST((SELECT validade_ate FROM orcamentos WHERE id = ${doc.id}) + 1, CURRENT_DATE + 1)::timestamptz)`);
    const caminho = `/api/propostas/${token}`;
    const url = corpo.data.origem ? new URL(caminho, corpo.data.origem).toString() : caminho;
    const msg = `Olá, ${doc.clienteNome.split(' ')[0]}! Segue a proposta ${doc.codigo}${doc.versao > 1 ? ` (versão ${doc.versao})` : ''} `
      + `no valor de ${dinheiroBR(doc.totais.total)}: ${url}`;
    return res.code(201).send({ caminho, url, whatsapp: linkWhatsapp(doc.clienteTelefone, msg), mensagem: msg });
  });

  // Público (sem login): o cliente abre o PDF pelo link.
  app.get<{ Params: { token: string } }>('/api/propostas/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, res) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(req.params.token)) return res.code(404).send({ erro: 'Link inválido.' });
    const { rows } = await app.db.execute<{ orcamentoId: string; detalhar: boolean; codigo: string; versao: number }>(sql`
      UPDATE orcamento_links_publicos l SET acessos = acessos + 1
        FROM orcamentos o
       WHERE l.token_hash = ${hashToken(req.params.token)} AND l.expira_em > NOW() AND o.id = l.orcamento_id
      RETURNING l.orcamento_id AS "orcamentoId", l.detalhar, o.codigo_sequencial AS codigo, o.versao`);
    const l = rows[0];
    if (!l) return res.code(404).send({ erro: 'Link vencido ou inválido. Peça um novo ao vendedor.' });
    return enviarPdf(res, l.orcamentoId, l.detalhar, `proposta-${l.codigo}-v${l.versao}`);
  });
}
