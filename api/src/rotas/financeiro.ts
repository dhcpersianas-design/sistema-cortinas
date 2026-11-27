import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { d } from '@sistema/motor-calculo';
import { exigir } from '../auth/plugin.js';
import { pode } from '../auth/permissoes.js';
import { mensagemErro, termoLike, textoOpcional } from '../cadastros/campos.js';
import { parametro } from '../catalogo/parametros.js';
import {
  ErroFinanceiro, estornarRecebimento, FORMAS_RECEBIMENTO, inserirLancamento, contaPadrao, receberDoCliente, rotinaFinanceira,
  situacaoMei, NOME_FORMA, taxaDe, BANDEIRAS, simularCartao,
} from '../financeiro/servico.js';
import { ErroPedido, lerPedido, pedidoNoEscopo, registrarEvento } from '../pedidos/servico.js';
import { hojeLoja } from '../pedidos/dias-uteis.js';

/**
 * Financeiro (só ADMIN): contas a receber e a pagar, taxas de cartão, contas, despesas fixas, parâmetros,
 * resumo com o limite do MEI. Pós-venda: ADMIN vê todos; VENDEDOR, os dos pedidos dele.
 */

const uuid = z.uuid();
const dinheiroTxt = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const t = String(v).trim();
  const s = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) { ctx.addIssue({ code: 'custom', message: `Valor inválido: "${v}"` }); return z.NEVER; }
  return s;
});
const pctTxt = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const s = String(v).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) > 100) { ctx.addIssue({ code: 'custom', message: `Percentual inválido: "${v}"` }); return z.NEVER; }
  return s;
});
const dataTxt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD).');

/** Parâmetros que o ADMIN edita na tela (rótulo e limites). */
export const PARAMETROS_EDITAVEIS: Record<string, { rotulo: string; dica: string; min: number; max: number }> = {
  LIMITE_FATURAMENTO_ANUAL_MEI: { rotulo: 'Limite anual do MEI (R$)', dica: 'Valor legal vigente. Confirme com o contador.', min: 0, max: 10_000_000 },
  ALERTA_LIMITE_MEI_PCT: { rotulo: 'Avisar ao chegar em (% do limite)', dica: 'Padrão 80%.', min: 1, max: 100 },
  SINAL_PADRAO_PCT: { rotulo: 'Sinal padrão do pedido (%)', dica: 'O resto vira o saldo cobrado na instalação.', min: 0, max: 100 },
  ALIQUOTA_IMPOSTO_VENDA_PCT: { rotulo: 'Imposto sobre a venda (%)', dica: 'MEI = 0 (o DAS é despesa fixa). Só muda se migrar para o Simples.', min: 0, max: 50 },
  SEMAFORO_VERDE_MIN_PCT: { rotulo: 'Margem verde a partir de (%)', dica: 'Padrão 45%.', min: 0, max: 100 },
  SEMAFORO_AMARELO_MIN_PCT: { rotulo: 'Margem amarela a partir de (%)', dica: 'Padrão 35%. Abaixo disso pede a senha do administrador.', min: 0, max: 100 },
  MARKUP_PADRAO_PCT: { rotulo: 'Markup padrão do catálogo (%)', dica: '100% = venda é o dobro do custo.', min: 0, max: 1000 },
  REPASSAR_TAXA_CARTAO: { rotulo: 'Embutir a taxa no parcelado acima do "sem juros" (1 = sim, 0 = não)', dica: 'Com 1, de 4x a 12x o cliente paga o valor cheio com a taxa embutida.', min: 0, max: 1 },
  PARCELAS_SEM_JUROS: { rotulo: 'Cartão sem juros até quantas parcelas', dica: 'Padrão 3x. Até aqui (e no débito) o cliente paga o valor cheio e a loja paga a taxa. O desconto vale só no PIX.', min: 1, max: 12 },
  POS_VENDA_DIAS: { rotulo: 'Pós-venda: ligar quantos dias depois da instalação', dica: 'Padrão 7 dias.', min: 1, max: 90 },
};

export async function rotasFinanceiro(app: FastifyInstance) {
  const admin = { preHandler: exigir('financeiro.gerenciar') };

  function falhar(res: FastifyReply, e: unknown) {
    if (e instanceof ErroFinanceiro || e instanceof ErroPedido) return res.code(e.status).send({ erro: e.message });
    throw e;
  }
  const corpoOu400 = <T extends z.ZodType>(esquema: T, req: FastifyRequest, res: FastifyReply): z.infer<T> | null => {
    const r = esquema.safeParse(req.body ?? {});
    if (!r.success) { res.code(400).send({ erro: mensagemErro(r.error) }); return null; }
    return r.data;
  };

  // ---------------------------------------------------------------- resumo (painel do financeiro)
  app.get('/api/financeiro/resumo', admin, async (req) => {
    const lojaId = req.usuario!.lojaId;
    await rotinaFinanceira(app.db, lojaId);
    const hoje = hojeLoja();
    const { rows: [faixas] } = await app.db.execute<Record<string, string>>(sql`
      SELECT
        ${sql.raw(['RECEITA', 'DESPESA'].map((t) => {
          const k = t === 'RECEITA' ? 'receber' : 'pagar';
          const base = `tipo = '${t}' AND status = 'PREVISTO'${t === 'RECEITA' ? ' AND NOT cartao' : ''}`;
          return [
            `COALESCE(SUM(valor_bruto) FILTER (WHERE ${base} AND data_vencimento < '${hoje}'), 0)::text AS "${k}Vencido"`,
            `COALESCE(SUM(valor_bruto) FILTER (WHERE ${base} AND data_vencimento = '${hoje}'), 0)::text AS "${k}Hoje"`,
            `COALESCE(SUM(valor_bruto) FILTER (WHERE ${base} AND data_vencimento > '${hoje}' AND data_vencimento <= '${hoje}'::date + 7), 0)::text AS "${k}7"`,
            `COALESCE(SUM(valor_bruto) FILTER (WHERE ${base} AND data_vencimento > '${hoje}' AND data_vencimento <= '${hoje}'::date + 30), 0)::text AS "${k}30"`,
            `COALESCE(SUM(valor_bruto) FILTER (WHERE ${base}), 0)::text AS "${k}Total"`,
          ].join(',\n');
        }).join(',\n'))},
        COALESCE(SUM(valor_liquido) FILTER (WHERE tipo = 'RECEITA' AND status = 'PREVISTO' AND cartao), 0)::text AS "maquininha"
      FROM lancamentos_financeiros WHERE loja_id = ${lojaId}`);
    const contas = await saldosContas(lojaId);
    const saldo = contas.reduce((s, c) => s.plus(d(c.saldo)), d(0));
    const { rows: semNota } = await app.db.execute(sql`
      SELECT id, numero_pedido AS numero FROM pedidos
       WHERE loja_id = ${lojaId} AND status_operacional = 'INSTALADO_CONCLUIDO' AND nfe_numero IS NULL AND nfse_numero IS NULL
       ORDER BY data_instalacao_realizada DESC LIMIT 50`);
    const { rows: instaladosComSaldo } = await app.db.execute(sql`
      SELECT p.id, p.numero_pedido AS numero, c.nome_completo AS cliente, SUM(l.valor_bruto)::text AS saldo
        FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
        JOIN lancamentos_financeiros l ON l.pedido_id = p.id AND l.tipo = 'RECEITA' AND l.status = 'PREVISTO' AND NOT l.cartao
       WHERE p.loja_id = ${lojaId} AND p.status_operacional = 'INSTALADO_CONCLUIDO'
       GROUP BY p.id, c.nome_completo ORDER BY MIN(l.data_vencimento) LIMIT 50`);
    const { rows: [conf] } = await app.db.execute<{ taxas: number; das: boolean }>(sql`
      SELECT (SELECT COUNT(*) FROM taxas_pagamento WHERE taxa_mdr_pct + taxa_antecip_pct > 0)::int AS taxas,
             EXISTS (SELECT 1 FROM despesas_recorrentes r JOIN plano_contas pc ON pc.id = r.plano_conta_id
                      WHERE r.loja_id = ${lojaId} AND pc.codigo = '5.04' AND r.ativo AND r.valor > 0) AS das`);
    const pendencias: string[] = [];
    if (!conf!.taxas) pendencias.push('As taxas da maquininha ainda estão em 0%. Preencha em Configurar > Taxas para o lucro sair certo.');
    if (!conf!.das) pendencias.push('O DAS do MEI ainda não está ligado. Informe o valor em Configurar > Despesas fixas.');
    return {
      hoje, faixas, saldo: saldo.toFixed(2), contas, mei: await situacaoMei(app.db, lojaId),
      semNota, instaladosComSaldo, pendencias,
    };
  });

  async function saldosContas(lojaId: string) {
    const { rows } = await app.db.execute<{ id: string; nome: string; tipo: string; saldoInicial: string; saldo: string; ativo: boolean }>(sql`
      SELECT c.id, c.nome, c.tipo, c.ativo, COALESCE(c.saldo_inicial, 0)::text AS "saldoInicial",
             (COALESCE(c.saldo_inicial, 0)
              + COALESCE((SELECT SUM(CASE WHEN l.tipo = 'RECEITA' THEN l.valor_liquido ELSE -l.valor_liquido END)
                            FROM lancamentos_financeiros l WHERE l.conta_id = c.id AND l.status = 'LIQUIDADO'), 0))::text AS saldo
        FROM contas_financeiras c WHERE c.loja_id = ${lojaId} ORDER BY c.ativo DESC, c.nome`);
    return rows;
  }

  // ---------------------------------------------------------------- lançamentos (a receber / a pagar)
  app.get('/api/financeiro/lancamentos', admin, async (req, res) => {
    const f = z.object({
      tipo: z.enum(['RECEITA', 'DESPESA']).optional(),
      situacao: z.enum(['ABERTO', 'VENCIDO', 'PAGO', 'CANCELADO', 'TODOS']).default('ABERTO'),
      de: dataTxt.optional(), ate: dataTxt.optional(),
      q: z.string().trim().max(100).optional(),
      pedidoId: uuid.optional(),
    }).safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const lojaId = req.usuario!.lojaId;
    await rotinaFinanceira(app.db, lojaId);
    const { tipo, situacao, de, ate, q, pedidoId } = f.data;
    const hoje = hojeLoja();
    const sit = {
      ABERTO: sql`l.status = 'PREVISTO'`,
      VENCIDO: sql`l.status = 'PREVISTO' AND l.data_vencimento < ${hoje}::date`,
      PAGO: sql`l.status = 'LIQUIDADO'`,
      CANCELADO: sql`l.status = 'CANCELADO'`,
      TODOS: sql`l.status <> 'CANCELADO'`,
    }[situacao];
    const campoData = situacao === 'PAGO' ? sql`l.data_liquidacao` : sql`l.data_vencimento`;
    const termo = q ? termoLike(q) : null;
    const { rows } = await app.db.execute(sql`
      SELECT l.id, l.tipo, l.origem, l.descricao, l.pedido_id AS "pedidoId", p.numero_pedido AS "pedidoNumero",
             c.nome_completo AS cliente, f.nome_fantasia AS fornecedor, l.fornecedor_id AS "fornecedorId",
             l.forma_pagamento AS forma, l.numero_parcela AS parcela, l.total_parcelas AS "totalParcelas",
             l.valor_bruto AS valor, l.taxa_transacao AS taxa, l.valor_liquido AS liquido,
             to_char(l.data_competencia, 'YYYY-MM-DD') AS competencia, to_char(l.data_vencimento, 'YYYY-MM-DD') AS vencimento,
             to_char(l.data_liquidacao, 'YYYY-MM-DD') AS liquidacao, l.status, l.cartao, l.editado_manual AS editado,
             (l.status = 'PREVISTO' AND l.data_vencimento < ${hoje}::date) AS vencido,
             pc.codigo AS "contaCodigo", pc.nome AS "contaNome", pc.id AS "planoContaId", cf.nome AS "contaFinanceira", l.observacoes
        FROM lancamentos_financeiros l
        JOIN plano_contas pc ON pc.id = l.plano_conta_id
        LEFT JOIN pedidos p ON p.id = l.pedido_id
        LEFT JOIN clientes c ON c.id = COALESCE(l.cliente_id, p.cliente_id)
        LEFT JOIN fornecedores f ON f.id = l.fornecedor_id
        LEFT JOIN contas_financeiras cf ON cf.id = l.conta_id
       WHERE l.loja_id = ${lojaId} AND ${sit}
         AND (${tipo ?? null}::text IS NULL OR l.tipo::text = ${tipo ?? null})
         AND (${de ?? null}::date IS NULL OR ${campoData} >= ${de ?? null}::date)
         AND (${ate ?? null}::date IS NULL OR ${campoData} <= ${ate ?? null}::date)
         AND (${pedidoId ?? null}::uuid IS NULL OR l.pedido_id = ${pedidoId ?? null}::uuid)
         AND (${termo}::text IS NULL OR f_busca(CONCAT_WS(' ', l.descricao, c.nome_completo, f.nome_fantasia, p.numero_pedido)) LIKE f_busca(${termo}))
       ORDER BY ${situacao === 'PAGO' ? sql`l.data_liquidacao DESC` : sql`l.data_vencimento`}, l.criado_em
       LIMIT 500`);
    const total = rows.reduce((s, r) => s.plus(d(String((r as { valor: string }).valor))), d(0));
    return { lancamentos: rows, total: total.toFixed(2), hoje };
  });

  const novoLanc = z.object({
    tipo: z.enum(['RECEITA', 'DESPESA']),
    descricao: z.string().trim().min(2, 'Descreva o lançamento').max(200),
    planoContaId: z.coerce.number().int(),
    valor: dinheiroTxt,
    vencimento: dataTxt,
    competencia: dataTxt.nullish(),
    fornecedorId: uuid.nullish(),
    pedidoId: uuid.nullish(),
    forma: z.enum(FORMAS_RECEBIMENTO).nullish(),
    observacoes: textoOpcional(500),
    pago: z.object({ data: dataTxt, contaFinanceiraId: uuid.nullish() }).nullish(),
  });

  /** Lançamento à mão (despesa avulsa, receita avulsa, refação de um pedido...). */
  app.post('/api/financeiro/lancamentos', admin, async (req, res) => {
    const e = corpoOu400(novoLanc, req, res);
    if (!e) return;
    const u = req.usuario!;
    const [pc] = (await app.db.execute<{ codigo: string; grupo: string }>(sql`
      SELECT codigo, grupo_dre AS grupo FROM plano_contas WHERE id = ${e.planoContaId}`)).rows;
    if (!pc) return res.code(400).send({ erro: 'Escolha a conta (categoria) do lançamento.' });
    if ((e.tipo === 'RECEITA') !== (pc.grupo === 'RECEITA')) {
      return res.code(400).send({ erro: e.tipo === 'RECEITA' ? 'Receita precisa de uma conta de receita (1.xx).' : 'Despesa não pode usar conta de receita.' });
    }
    if (d(e.valor).lte(0)) return res.code(400).send({ erro: 'Informe o valor.' });
    let clienteId: string | null = null;
    if (e.pedidoId) {
      const p = await lerPedido(app.db, e.pedidoId);
      if (!p || p.lojaId !== u.lojaId) return res.code(400).send({ erro: 'Pedido não encontrado.' });
      clienteId = p.clienteId;
    }
    const id = await inserirLancamento(app.db, {
      lojaId: u.lojaId, tipo: e.tipo, origem: 'MANUAL', planoConta: pc.codigo, descricao: e.descricao, valor: d(e.valor),
      competencia: e.competencia ?? e.vencimento, vencimento: e.vencimento, fornecedorId: e.fornecedorId ?? null,
      pedidoId: e.pedidoId ?? null, clienteId, forma: e.forma ?? null, observacoes: e.observacoes ?? null, usuarioId: u.id,
      status: e.pago ? 'LIQUIDADO' : 'PREVISTO', liquidacao: e.pago?.data ?? null, contaFinanceiraId: e.pago?.contaFinanceiraId ?? null,
    });
    return res.code(201).send({ id });
  });

  async function lancamentoDaLoja(req: FastifyRequest<{ Params: { id: string } }>, res: FastifyReply) {
    if (!uuid.safeParse(req.params.id).success) { res.code(404).send({ erro: 'Lançamento não encontrado.' }); return null; }
    const [l] = (await app.db.execute<{ id: string; tipo: string; origem: string; status: string; cartao: boolean; pedidoId: string | null; lojaId: string; forma: string | null; parcelas: number }>(sql`
      SELECT id, tipo, origem, status, cartao, pedido_id AS "pedidoId", loja_id AS "lojaId", forma_pagamento AS forma, total_parcelas AS parcelas
        FROM lancamentos_financeiros WHERE id = ${req.params.id}`)).rows;
    if (!l || l.lojaId !== req.usuario!.lojaId) { res.code(404).send({ erro: 'Lançamento não encontrado.' }); return null; }
    return l;
  }
  /** Cobrança em aberto do cliente de um pedido: baixa pelo "Receber" (precisa da forma de pagamento). */
  const cobrancaDePedido = (l: { tipo: string; pedidoId: string | null; cartao: boolean }) => l.tipo === 'RECEITA' && l.pedidoId && !l.cartao;

  app.put<{ Params: { id: string } }>('/api/financeiro/lancamentos/:id', admin, async (req, res) => {
    const l = await lancamentoDaLoja(req, res);
    if (!l) return;
    const e = corpoOu400(z.object({
      descricao: z.string().trim().min(2).max(200).optional(),
      valor: dinheiroTxt.optional(),
      vencimento: dataTxt.optional(),
      planoContaId: z.coerce.number().int().optional(),
      fornecedorId: uuid.nullish(),
      forma: z.enum(FORMAS_RECEBIMENTO).nullish(),
      observacoes: textoOpcional(500),
    }), req, res);
    if (!e) return;
    if (l.status !== 'PREVISTO') return res.code(409).send({ erro: 'Só dá para editar lançamento em aberto. Desfaça o pagamento antes.' });
    if (l.cartao) return res.code(409).send({ erro: 'Repasse da maquininha não se edita: desfaça o recebimento se estiver errado.' });
    if (e.valor !== undefined && d(e.valor).lte(0)) return res.code(400).send({ erro: 'Valor precisa ser maior que zero (para tirar, use Cancelar).' });
    const valor = e.valor ?? null;
    let taxa: string | null = null;
    if (valor && l.tipo === 'RECEITA') {
      const t = await taxaDe(app.db, e.forma === undefined ? l.forma : e.forma, l.parcelas);
      taxa = d(valor).mul(t.pct).div(100).toDecimalPlaces(2).toFixed(2);
    }
    await app.db.execute(sql`UPDATE lancamentos_financeiros SET
        descricao = COALESCE(${e.descricao ?? null}, descricao),
        valor_bruto = COALESCE(${valor}::numeric, valor_bruto),
        taxa_transacao = COALESCE(${taxa}::numeric, CASE WHEN ${valor}::numeric IS NULL THEN taxa_transacao ELSE 0 END),
        valor_liquido = COALESCE(${valor}::numeric, valor_bruto) - COALESCE(${taxa}::numeric, CASE WHEN ${valor}::numeric IS NULL THEN taxa_transacao ELSE 0 END),
        data_vencimento = COALESCE(${e.vencimento ?? null}::date, data_vencimento),
        plano_conta_id = COALESCE(${e.planoContaId ?? null}::int, plano_conta_id),
        fornecedor_id = CASE WHEN ${e.fornecedorId === undefined} THEN fornecedor_id ELSE ${e.fornecedorId ?? null}::uuid END,
        forma_pagamento = CASE WHEN ${e.forma === undefined} THEN forma_pagamento ELSE ${e.forma ?? null}::forma_pagamento_enum END,
        observacoes = CASE WHEN ${e.observacoes === undefined} THEN observacoes ELSE ${e.observacoes ?? null} END,
        editado_manual = TRUE, atualizado_em = NOW()
      WHERE id = ${l.id}`);
    return { ok: true };
  });

  /** Dar baixa (pago / recebido). Cobrança de pedido usa /api/pedidos/:id/receber. */
  app.post<{ Params: { id: string } }>('/api/financeiro/lancamentos/:id/liquidar', admin, async (req, res) => {
    const l = await lancamentoDaLoja(req, res);
    if (!l) return;
    const e = corpoOu400(z.object({ data: dataTxt, contaFinanceiraId: uuid.nullish(), valor: dinheiroTxt.optional() }), req, res);
    if (!e) return;
    if (l.status !== 'PREVISTO') return res.code(409).send({ erro: 'Este lançamento não está em aberto.' });
    if (cobrancaDePedido(l)) return res.code(409).send({ erro: 'Cobrança de pedido: use "Receber" para informar a forma de pagamento.' });
    const conta = e.contaFinanceiraId ?? await contaPadrao(app.db, l.lojaId, l.forma);
    await app.db.execute(sql`UPDATE lancamentos_financeiros SET status = 'LIQUIDADO', data_liquidacao = ${e.data}::date, conta_id = ${conta},
        valor_bruto = COALESCE(${e.valor ?? null}::numeric, valor_bruto),
        valor_liquido = COALESCE(${e.valor ?? null}::numeric, valor_bruto) - taxa_transacao,
        editado_manual = editado_manual OR ${e.valor !== undefined}, liquidado_por_id = ${req.usuario!.id}, atualizado_em = NOW()
      WHERE id = ${l.id}`);
    return { ok: true };
  });

  /** Desfaz a baixa. Recebimento de pedido volta a ser cobrança em aberto do cliente. */
  app.post<{ Params: { id: string } }>('/api/financeiro/lancamentos/:id/desfazer', admin, async (req, res) => {
    const l = await lancamentoDaLoja(req, res);
    if (!l) return;
    try {
      if (l.tipo === 'RECEITA' && l.pedidoId && ['RECEBIDO', 'CARTAO'].includes(l.origem)) {
        const r = await app.db.transaction(async (tx) => {
          const x = await estornarRecebimento(tx, l.id, req.usuario!.id);
          await registrarEvento(tx, x.pedidoId, req.usuario!.id, 'FINANCEIRO', `Recebimento de R$ ${x.valor} desfeito: volta a ser cobrado do cliente.`);
          return x;
        });
        return { ok: true, ...r };
      }
      if (l.status !== 'LIQUIDADO') return res.code(409).send({ erro: 'Este lançamento não está pago.' });
      await app.db.execute(sql`UPDATE lancamentos_financeiros SET status = 'PREVISTO', data_liquidacao = NULL, liquidado_por_id = NULL,
        atualizado_em = NOW() WHERE id = ${l.id}`);
      return { ok: true };
    } catch (x) { return falhar(res, x); }
  });

  app.post<{ Params: { id: string } }>('/api/financeiro/lancamentos/:id/cancelar', admin, async (req, res) => {
    const l = await lancamentoDaLoja(req, res);
    if (!l) return;
    if (l.status !== 'PREVISTO' || l.cartao) return res.code(409).send({ erro: 'Só dá para cancelar lançamento em aberto.' });
    await app.db.execute(sql`UPDATE lancamentos_financeiros SET status = 'CANCELADO', editado_manual = TRUE, atualizado_em = NOW() WHERE id = ${l.id}`);
    if (l.pedidoId && l.tipo === 'RECEITA') {
      await registrarEvento(app.db, l.pedidoId, req.usuario!.id, 'FINANCEIRO', 'Cobrança cancelada no financeiro (abatimento ao cliente).');
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- receber do cliente (pedido)
  app.post<{ Params: { id: string } }>('/api/pedidos/:id/receber', admin, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Pedido não encontrado.' });
    const e = corpoOu400(z.object({
      valor: dinheiroTxt, forma: z.enum(FORMAS_RECEBIMENTO), data: dataTxt,
      parcelas: z.coerce.number().int().min(1).max(24).optional(),
      contaFinanceiraId: uuid.nullish(), lancamentoId: uuid.nullish(), bandeira: z.enum(BANDEIRAS).nullish(),
    }), req, res);
    if (!e) return;
    const u = req.usuario!;
    try {
      const r = await app.db.transaction(async (tx) => {
        const p = await lerPedido(tx, req.params.id);
        if (!p || !pedidoNoEscopo(u, p)) throw new ErroFinanceiro('Pedido não encontrado.', 404);
        await tx.execute(sql`SELECT id FROM pedidos WHERE id = ${p.id} FOR UPDATE`);
        const x = await receberDoCliente(tx, p.id, e, u.id);
        const parc = e.forma === 'CREDITO_PARCELADO' ? ` em ${e.parcelas ?? 2}x` : '';
        const naMaquina = x.cobrado !== d(e.valor).toFixed(2) ? `, passou R$ ${x.cobrado} na maquininha` : '';
        await registrarEvento(tx, p.id, u.id, 'RECEBIMENTO',
          `Recebido R$ ${d(e.valor).toFixed(2)} (${NOME_FORMA[e.forma]}${parc}${naMaquina}) em ${e.data.split('-').reverse().join('/')}. Falta R$ ${x.emAbertoDepois}.`,
          { valor: e.valor, forma: e.forma });
        return x;
      });
      return r;
    } catch (x) { return falhar(res, x); }
  });

  /**
   * Simulação do cartão para as telas de recebimento (admin e vendedor): quanto passar na maquininha
   * com a taxa embutida. Para o vendedor só devolve o valor a cobrar (não mostra a taxa).
   */
  app.get('/api/financeiro/simular-cartao', { preHandler: exigir('pedidos.proprios') }, async (req, res) => {
    const q = z.object({
      valor: dinheiroTxt, forma: z.enum(FORMAS_RECEBIMENTO), parcelas: z.coerce.number().int().min(1).max(24).default(1),
      bandeira: z.enum(BANDEIRAS).default('VISA_MASTER'),
    }).safeParse(req.query);
    if (!q.success) return res.code(400).send({ erro: mensagemErro(q.error) });
    const r = await simularCartao(app.db, req.usuario!.lojaId, d(q.data.valor), q.data.forma, q.data.parcelas, q.data.bandeira);
    if (pode(req.usuario!, 'financeiro.gerenciar')) return r;
    return { repasse: r.repasse, cobrado: r.cobrado, parcelas: r.parcelas, valorParcela: r.valorParcela };
  });

  // ---------------------------------------------------------------- configurações
  app.get('/api/financeiro/config', admin, async (req) => {
    const lojaId = req.usuario!.lojaId;
    const { rows: taxas } = await app.db.execute(sql`
      SELECT id, forma_pagamento AS forma, parcelas, bandeira, taxa_mdr_pct AS mdr, taxa_antecip_pct AS antecipacao, dias_repasse AS "diasRepasse"
        FROM taxas_pagamento
       ORDER BY array_position(ARRAY['TODAS','VISA_MASTER','ELO_AMEX']::text[], bandeira::text),
                array_position(ARRAY['PIX','DINHEIRO','BOLETO','DEBITO','CREDITO_AVISTA','CREDITO_PARCELADO']::text[], forma_pagamento::text), parcelas`);
    const { rows: recorrentes } = await app.db.execute(sql`
      SELECT r.id, r.descricao, r.plano_conta_id AS "planoContaId", pc.codigo AS "contaCodigo", pc.nome AS "contaNome",
             r.fornecedor_id AS "fornecedorId", f.nome_fantasia AS fornecedor, r.valor, r.dia_vencimento AS dia,
             to_char(r.inicio, 'YYYY-MM-DD') AS inicio, r.ativo
        FROM despesas_recorrentes r JOIN plano_contas pc ON pc.id = r.plano_conta_id LEFT JOIN fornecedores f ON f.id = r.fornecedor_id
       WHERE r.loja_id = ${lojaId} ORDER BY r.ativo DESC, r.descricao`);
    const { rows: plano } = await app.db.execute(sql`SELECT id, codigo, nome, grupo_dre AS grupo FROM plano_contas ORDER BY codigo`);
    const parametros = [];
    for (const [chave, meta] of Object.entries(PARAMETROS_EDITAVEIS)) {
      parametros.push({ chave, ...meta, valor: await parametro(app.db, lojaId, chave) });
    }
    return { taxas, contas: await saldosContas(lojaId), recorrentes, planoContas: plano, parametros };
  });

  app.put('/api/financeiro/taxas', admin, async (req, res) => {
    const e = corpoOu400(z.object({ taxas: z.array(z.object({
      id: z.coerce.number().int(), mdr: pctTxt, antecipacao: pctTxt, diasRepasse: z.coerce.number().int().min(0).max(120),
    })).max(100) }), req, res);
    if (!e) return;
    await app.db.transaction(async (tx) => {
      for (const t of e.taxas) {
        await tx.execute(sql`UPDATE taxas_pagamento SET taxa_mdr_pct = ${t.mdr}, taxa_antecip_pct = ${t.antecipacao},
          dias_repasse = ${t.diasRepasse} WHERE id = ${t.id}`);
      }
    });
    return { ok: true };
  });

  app.post('/api/financeiro/taxas', admin, async (req, res) => {
    const e = corpoOu400(z.object({
      forma: z.enum(FORMAS_RECEBIMENTO), parcelas: z.coerce.number().int().min(1).max(24), bandeira: z.enum(BANDEIRAS).default('VISA_MASTER'),
    }), req, res);
    if (!e) return;
    const n = e.forma === 'CREDITO_PARCELADO' ? Math.max(2, e.parcelas) : 1;
    const cartao = ['DEBITO', 'CREDITO_AVISTA', 'CREDITO_PARCELADO'].includes(e.forma);
    await app.db.execute(sql`INSERT INTO taxas_pagamento (forma_pagamento, parcelas, dias_repasse, bandeira)
      VALUES (${e.forma}::forma_pagamento_enum, ${n}, ${['DEBITO'].includes(e.forma) ? 1 : e.forma.startsWith('CREDITO') ? 30 : 0},
              ${cartao ? e.bandeira : 'TODAS'})
      ON CONFLICT (forma_pagamento, parcelas, bandeira) DO NOTHING`);
    return res.code(201).send({ ok: true });
  });

  const contaEntrada = z.object({
    nome: z.string().trim().min(2).max(100),
    tipo: z.enum(['CONTA_CORRENTE', 'CAIXA', 'MAQUININHA']),
    saldoInicial: z.union([z.string(), z.number()]).transform((v, ctx) => {
      const s = String(v).trim().replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
      if (!/^-?\d+(\.\d{1,2})?$/.test(s)) { ctx.addIssue({ code: 'custom', message: 'Saldo inicial inválido' }); return z.NEVER; }
      return s;
    }),
    ativo: z.boolean().default(true),
  });
  app.post('/api/financeiro/contas', admin, async (req, res) => {
    const e = corpoOu400(contaEntrada, req, res);
    if (!e) return;
    await app.db.execute(sql`INSERT INTO contas_financeiras (loja_id, nome, tipo, saldo_inicial, ativo)
      VALUES (${req.usuario!.lojaId}, ${e.nome}, ${e.tipo}, ${e.saldoInicial}, ${e.ativo})`);
    return res.code(201).send({ ok: true });
  });
  app.put<{ Params: { id: string } }>('/api/financeiro/contas/:id', admin, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Conta não encontrada.' });
    const e = corpoOu400(contaEntrada, req, res);
    if (!e) return;
    const r = await app.db.execute(sql`UPDATE contas_financeiras SET nome = ${e.nome}, tipo = ${e.tipo}, saldo_inicial = ${e.saldoInicial},
      ativo = ${e.ativo} WHERE id = ${req.params.id} AND loja_id = ${req.usuario!.lojaId}`);
    if (!r.rowCount) return res.code(404).send({ erro: 'Conta não encontrada.' });
    return { ok: true };
  });

  const recorrenteEntrada = z.object({
    descricao: z.string().trim().min(2).max(150),
    planoContaId: z.coerce.number().int(),
    fornecedorId: uuid.nullish(),
    valor: dinheiroTxt,
    dia: z.coerce.number().int().min(1).max(28),
    inicio: dataTxt.optional(),
    ativo: z.boolean().default(true),
  });
  async function validarContaDespesa(id: number) {
    const [pc] = (await app.db.execute<{ grupo: string }>(sql`SELECT grupo_dre AS grupo FROM plano_contas WHERE id = ${id}`)).rows;
    return pc && pc.grupo !== 'RECEITA';
  }
  app.post('/api/financeiro/recorrentes', admin, async (req, res) => {
    const e = corpoOu400(recorrenteEntrada, req, res);
    if (!e) return;
    if (!await validarContaDespesa(e.planoContaId)) return res.code(400).send({ erro: 'Escolha uma conta de despesa.' });
    await app.db.execute(sql`INSERT INTO despesas_recorrentes (loja_id, descricao, plano_conta_id, fornecedor_id, valor, dia_vencimento, inicio, ativo)
      VALUES (${req.usuario!.lojaId}, ${e.descricao}, ${e.planoContaId}, ${e.fornecedorId ?? null}, ${e.valor}, ${e.dia},
              date_trunc('month', COALESCE(${e.inicio ?? null}::date, CURRENT_DATE))::date, ${e.ativo})`);
    return res.code(201).send({ ok: true });
  });
  app.put<{ Params: { id: string } }>('/api/financeiro/recorrentes/:id', admin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.code(404).send({ erro: 'Despesa fixa não encontrada.' });
    const e = corpoOu400(recorrenteEntrada, req, res);
    if (!e) return;
    if (!await validarContaDespesa(e.planoContaId)) return res.code(400).send({ erro: 'Escolha uma conta de despesa.' });
    // Ligar uma despesa que estava desligada começa a lançar a partir deste mês (não cobra meses passados).
    const r = await app.db.execute(sql`UPDATE despesas_recorrentes SET descricao = ${e.descricao}, plano_conta_id = ${e.planoContaId},
        fornecedor_id = ${e.fornecedorId ?? null}, valor = ${e.valor}, dia_vencimento = ${e.dia},
        inicio = CASE WHEN ${e.inicio ?? null}::date IS NOT NULL THEN date_trunc('month', ${e.inicio ?? null}::date)::date
                      WHEN NOT ativo AND ${e.ativo} THEN date_trunc('month', CURRENT_DATE)::date ELSE inicio END,
        ativo = ${e.ativo}
      WHERE id = ${id} AND loja_id = ${req.usuario!.lojaId}`);
    if (!r.rowCount) return res.code(404).send({ erro: 'Despesa fixa não encontrada.' });
    // Lançamentos futuros ainda em aberto acompanham o novo valor e o novo dia.
    await app.db.execute(sql`UPDATE lancamentos_financeiros SET valor_bruto = ${e.valor}, valor_liquido = ${e.valor},
        data_vencimento = (mes_referencia + (${e.dia} - 1)), data_competencia = (mes_referencia + (${e.dia} - 1)), atualizado_em = NOW()
      WHERE despesa_recorrente_id = ${id} AND status = 'PREVISTO' AND NOT editado_manual
        AND mes_referencia >= date_trunc('month', CURRENT_DATE)::date`);
    if (!e.ativo) {
      await app.db.execute(sql`UPDATE lancamentos_financeiros SET status = 'CANCELADO', atualizado_em = NOW()
        WHERE despesa_recorrente_id = ${id} AND status = 'PREVISTO' AND mes_referencia > date_trunc('month', CURRENT_DATE)::date`);
    }
    return { ok: true };
  });

  app.put('/api/financeiro/parametros', admin, async (req, res) => {
    const e = corpoOu400(z.object({ valores: z.record(z.string(), z.union([z.string(), z.number()])) }), req, res);
    if (!e) return;
    const lojaId = req.usuario!.lojaId;
    const hoje = hojeLoja();
    const limpos: [string, string][] = [];
    for (const [chave, bruto] of Object.entries(e.valores)) {
      const meta = PARAMETROS_EDITAVEIS[chave];
      if (!meta) return res.code(400).send({ erro: `Parâmetro desconhecido: ${chave}` });
      const t = String(bruto).trim();
      const s = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
      if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) < meta.min || Number(s) > meta.max) {
        return res.code(400).send({ erro: `${meta.rotulo}: valor inválido.` });
      }
      limpos.push([chave, s]);
    }
    const v = Object.fromEntries(limpos);
    const verde = v.SEMAFORO_VERDE_MIN_PCT ?? await parametro(app.db, lojaId, 'SEMAFORO_VERDE_MIN_PCT');
    const amarelo = v.SEMAFORO_AMARELO_MIN_PCT ?? await parametro(app.db, lojaId, 'SEMAFORO_AMARELO_MIN_PCT');
    if (verde && amarelo && d(amarelo).gt(d(verde))) return res.code(400).send({ erro: 'A margem amarela precisa ser menor que a verde.' });
    await app.db.transaction(async (tx) => {
      for (const [chave, valor] of limpos) {
        // Vale a partir de hoje (o histórico fica guardado pela vigência).
        await tx.execute(sql`INSERT INTO parametros_sistema (loja_id, chave, valor, vigente_desde) VALUES (${lojaId}, ${chave}, ${valor}, ${hoje}::date)
          ON CONFLICT (loja_id, chave, vigente_desde) DO UPDATE SET valor = EXCLUDED.valor`);
      }
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- MEI (alerta para o painel inicial)
  app.get('/api/financeiro/mei', admin, async (req) => ({ mei: await situacaoMei(app.db, req.usuario!.lojaId) }));

  // ---------------------------------------------------------------- pós-venda
  app.get('/api/pos-venda', { preHandler: exigir('pedidos.proprios') }, async (req, res) => {
    const f = z.object({ status: z.enum(['PENDENTE', 'FEITO', 'TODOS']).default('PENDENTE') }).safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const u = req.usuario!;
    const todos = pode(u, 'pedidos.todos');
    const { rows } = await app.db.execute(sql`
      SELECT pv.id, pv.pedido_id AS "pedidoId", p.numero_pedido AS numero, c.nome_completo AS cliente, c.telefone_whatsapp AS telefone,
             us.nome AS vendedor, to_char(pv.data_prevista, 'YYYY-MM-DD') AS "dataPrevista", pv.status, pv.nota, pv.comentario,
             pv.feito_em AS "feitoEm", p.data_instalacao_realizada AS "instaladoEm",
             (pv.status = 'PENDENTE' AND pv.data_prevista <= ${hojeLoja()}::date) AS "paraHoje"
        FROM pos_venda pv JOIN pedidos p ON p.id = pv.pedido_id JOIN clientes c ON c.id = p.cliente_id JOIN usuarios us ON us.id = p.vendedor_id
       WHERE pv.loja_id = ${u.lojaId} AND (${todos}::boolean OR p.vendedor_id = ${u.id})
         AND (${f.data.status} = 'TODOS' OR pv.status = ${f.data.status})
       ORDER BY pv.status = 'PENDENTE' DESC, pv.data_prevista, pv.criado_em LIMIT 300`);
    return { posVenda: rows };
  });

  app.post<{ Params: { id: string } }>('/api/pos-venda/:id', { preHandler: exigir('pedidos.proprios') }, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Pós-venda não encontrado.' });
    const e = corpoOu400(z.object({
      status: z.enum(['PENDENTE', 'FEITO', 'CANCELADO']),
      nota: z.coerce.number().int().min(1).max(5).nullish(),
      comentario: textoOpcional(1000),
    }), req, res);
    if (!e) return;
    const u = req.usuario!;
    const [pv] = (await app.db.execute<{ pedidoId: string; lojaId: string; vendedorId: string }>(sql`
      SELECT pv.pedido_id AS "pedidoId", pv.loja_id AS "lojaId", p.vendedor_id AS "vendedorId"
        FROM pos_venda pv JOIN pedidos p ON p.id = pv.pedido_id WHERE pv.id = ${req.params.id}`)).rows;
    if (!pv || !pedidoNoEscopo(u, pv)) return res.code(404).send({ erro: 'Pós-venda não encontrado.' });
    await app.db.execute(sql`UPDATE pos_venda SET status = ${e.status}, nota = ${e.nota ?? null}, comentario = ${e.comentario ?? null},
      feito_em = CASE WHEN ${e.status} = 'FEITO' THEN NOW() ELSE NULL END,
      feito_por_id = CASE WHEN ${e.status} = 'FEITO' THEN ${u.id}::uuid ELSE NULL END WHERE id = ${req.params.id}`);
    if (e.status === 'FEITO') {
      await registrarEvento(app.db, pv.pedidoId, u.id, 'POS_VENDA',
        `Pós-venda feito${e.nota ? ` (nota ${e.nota}/5)` : ''}${e.comentario ? `: ${e.comentario}` : '.'}`);
    }
    return { ok: true };
  });
}
