import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { d, dinheiro, type Decimal } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { parametro } from '../catalogo/parametros.js';
import { hojeLoja, somarDiasUteis } from '../pedidos/dias-uteis.js';

/**
 * Financeiro (especificação v1.1, seção 11). Tudo em decimal (nunca float).
 *
 * CONTAS A RECEBER (do pedido)
 *  - Na aprovação nasce o plano: sinal (SINAL_PADRAO_PCT, padrão 50%) vencendo hoje + saldo vencendo na
 *    instalação (ou na previsão de entrega). Venda no cartão: uma cobrança de 100% hoje.
 *  - "Receber" baixa as cobranças em aberto na ordem de vencimento (aceita valor parcial). No cartão, o
 *    valor vira os repasses da maquininha (parcela 1, 2, 3... com a taxa da tabela), que caem sozinhos
 *    como recebidos no dia do vencimento. O cliente não deve mais nada nesse caso.
 *  - Aditivo: diferença a mais entra na última cobrança em aberto; a menos, abate das cobranças em aberto
 *    e o que sobrar vira "devolver ao cliente" em Contas a pagar.
 *
 * CONTAS A PAGAR (geradas sozinhas)
 *  - Uma por ordem de compra (fornecedor, costureira, fábrica), com o custo previsto; quando a ordem
 *    chega com custo real, o valor é atualizado. Ordem cancelada cancela a conta (se ainda não paga).
 *  - Instalador terceirizado: ao agendar, com o custo dos serviços de instalação do pedido.
 *  - Comissão do vendedor (se houver comissão no cadastro).
 *  - Despesas fixas do mês (aluguel, DAS do MEI...), lançadas sozinhas todo mês.
 *
 * O sistema só altera sozinho lançamento que ele criou, que ainda está em aberto e que ninguém editou.
 */

type Tx = Parameters<Parameters<Banco['transaction']>[0]>[0];
export type Exec = Banco | Tx;

export class ErroFinanceiro extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function linhas<T>(db: Exec, q: SQL): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

export const FORMAS_RECEBIMENTO = ['PIX', 'DINHEIRO', 'DEBITO', 'CREDITO_AVISTA', 'CREDITO_PARCELADO', 'BOLETO'] as const;
export const FORMAS_CARTAO = ['DEBITO', 'CREDITO_AVISTA', 'CREDITO_PARCELADO'];
export const NOME_FORMA: Record<string, string> = {
  PIX: 'PIX', DINHEIRO: 'Dinheiro', DEBITO: 'Débito', CREDITO_AVISTA: 'Crédito à vista',
  CREDITO_PARCELADO: 'Crédito parcelado', BOLETO: 'Boleto', MISTO: 'Misto',
};

/** Categoria do catálogo -> conta de custo (CMV) do plano de contas. */
export const CONTA_CMV_DA_CATEGORIA: Record<number, string> = {
  1: '3.01', 2: '3.03', 3: '3.03', 4: '3.03', 5: '3.04', 6: '3.02', 7: '3.02', 8: '3.03', 9: '3.05',
};
const CATEGORIA_INSTALACAO = 9;

const FUSO = 'America/Sao_Paulo';

export function somarDias(iso: string, dias: number): string {
  const [a, m, dd] = iso.slice(0, 10).split('-').map(Number);
  const x = new Date(Date.UTC(a!, m! - 1, dd! + dias));
  return x.toISOString().slice(0, 10);
}

/** Divide um valor em n partes de centavos; a sobra fica na primeira parte. */
export function ratear(total: Decimal, n: number): Decimal[] {
  const base = total.div(n).toDecimalPlaces(2, 1); // para baixo
  const partes = Array.from({ length: n }, () => base);
  partes[0] = total.minus(base.mul(n - 1));
  return partes;
}

async function contaId(db: Exec, codigo: string): Promise<number> {
  const [c] = await linhas<{ id: number }>(db, sql`SELECT id FROM plano_contas WHERE codigo = ${codigo}`);
  if (!c) throw new ErroFinanceiro(`Conta ${codigo} não existe no plano de contas.`, 500);
  return c.id;
}

export type Taxa = { pct: Decimal; antecipPct: Decimal; diasRepasse: number; cadastrada: boolean };

/** Taxa da forma de pagamento (MDR + antecipação) e prazo de repasse. Sem cadastro = 0%. */
export async function taxaDe(db: Exec, forma: string | null, parcelas = 1): Promise<Taxa> {
  if (!forma) return { pct: d(0), antecipPct: d(0), diasRepasse: 0, cadastrada: false };
  const n = forma === 'CREDITO_PARCELADO' ? Math.max(2, parcelas) : 1;
  const [t] = await linhas<{ mdr: string; antecip: string; dias: number }>(db, sql`
    SELECT taxa_mdr_pct::text AS mdr, taxa_antecip_pct::text AS antecip, dias_repasse AS dias
      FROM taxas_pagamento WHERE forma_pagamento = ${forma}::forma_pagamento_enum AND parcelas = ${n}`);
  if (!t) return { pct: d(0), antecipPct: d(0), diasRepasse: FORMAS_CARTAO.includes(forma) ? 30 : 0, cadastrada: false };
  return { pct: d(t.mdr).plus(d(t.antecip)), antecipPct: d(t.antecip), diasRepasse: t.dias, cadastrada: true };
}

const valorTaxa = (bruto: Decimal, t: Taxa) => dinheiro(bruto.mul(t.pct).div(100));

// ------------------------------------------------------------------ contas a receber do pedido

type PedidoFin = {
  id: string; lojaId: string; numero: string; clienteId: string; vendedorId: string; status: string;
  valorTotal: string; forma: string | null; parcelas: number; dataVenda: string;
  previsao: string | null; instalacao: string | null; orcamentoId: string;
};

async function pedidoFin(db: Exec, pedidoId: string): Promise<PedidoFin> {
  const [p] = await linhas<PedidoFin>(db, sql`
    SELECT p.id, p.loja_id AS "lojaId", p.numero_pedido AS numero, p.cliente_id AS "clienteId", p.vendedor_id AS "vendedorId",
           p.status_operacional AS status, p.valor_total_final::text AS "valorTotal", p.forma_pagamento_final AS forma,
           GREATEST(COALESCE(o.parcelas, 1), 1) AS parcelas,
           to_char((p.data_compra AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS "dataVenda",
           to_char(p.data_previsao_entrega, 'YYYY-MM-DD') AS previsao,
           to_char((p.data_instalacao_agendada AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS instalacao,
           p.orcamento_id AS "orcamentoId"
      FROM pedidos p JOIN orcamentos o ON o.id = p.orcamento_id WHERE p.id = ${pedidoId}`);
  if (!p) throw new ErroFinanceiro('Pedido não encontrado.', 404);
  return p;
}

/** Quando cobrar o saldo: na instalação agendada; sem agenda, na previsão de entrega. */
async function vencimentoSaldo(db: Exec, p: PedidoFin): Promise<string> {
  if (p.instalacao) return p.instalacao;
  if (p.previsao) return p.previsao;
  const prazo = Number((await parametro(db as Banco, p.lojaId, 'PRAZO_ENTREGA_DIAS_UTEIS')) ?? 14);
  return somarDiasUteis(hojeLoja(), prazo);
}

type NovoLanc = {
  lojaId: string; tipo: 'RECEITA' | 'DESPESA'; origem: string; planoConta: string; descricao: string;
  valor: Decimal; taxa?: Decimal; competencia: string; vencimento: string;
  pedidoId?: string | null; clienteId?: string | null; fornecedorId?: string | null; vendedorId?: string | null;
  ordemCompraId?: string | null; forma?: string | null; parcela?: number; totalParcelas?: number;
  status?: 'PREVISTO' | 'LIQUIDADO'; liquidacao?: string | null; contaFinanceiraId?: string | null;
  cartao?: boolean; grupo?: string | null; usuarioId?: string | null; despesaRecorrenteId?: number | null; mesReferencia?: string | null;
  observacoes?: string | null;
};

/** Conta onde o dinheiro cai/sai quando ninguém escolheu: dinheiro vivo no caixa, o resto no banco. */
export async function contaPadrao(db: Exec, lojaId: string, forma: string | null): Promise<string | null> {
  const [c] = await linhas<{ id: string }>(db, sql`
    SELECT id FROM contas_financeiras WHERE loja_id = ${lojaId} AND ativo
     ORDER BY (tipo = ${forma === 'DINHEIRO' ? 'CAIXA' : 'CONTA_CORRENTE'}) DESC, nome LIMIT 1`);
  return c?.id ?? null;
}

export async function inserirLancamento(db: Exec, l: NovoLanc): Promise<string> {
  const taxa = l.taxa ?? d(0);
  const pc = await contaId(db, l.planoConta);
  if (l.status === 'LIQUIDADO' && !l.contaFinanceiraId) l.contaFinanceiraId = await contaPadrao(db, l.lojaId, l.forma ?? null);
  const [r] = await linhas<{ id: string }>(db, sql`
    INSERT INTO lancamentos_financeiros (loja_id, tipo, origem, pedido_id, cliente_id, fornecedor_id, vendedor_id, ordem_compra_id,
      plano_conta_id, conta_id, descricao, forma_pagamento, numero_parcela, total_parcelas, valor_bruto, taxa_transacao, valor_liquido,
      data_competencia, data_vencimento, data_liquidacao, status, cartao, grupo_pagamento_id, criado_por_id, liquidado_por_id,
      despesa_recorrente_id, mes_referencia, observacoes)
    VALUES (${l.lojaId}, ${l.tipo}::tipo_lancamento_enum, ${l.origem}, ${l.pedidoId ?? null}, ${l.clienteId ?? null}, ${l.fornecedorId ?? null},
      ${l.vendedorId ?? null}, ${l.ordemCompraId ?? null}, ${pc}, ${l.contaFinanceiraId ?? null}, ${l.descricao.slice(0, 200)},
      ${l.forma ?? null}::forma_pagamento_enum, ${l.parcela ?? 1}, ${l.totalParcelas ?? 1}, ${l.valor.toFixed(2)}, ${taxa.toFixed(2)},
      ${l.valor.minus(taxa).toFixed(2)}, ${l.competencia}::date, ${l.vencimento}::date, ${l.liquidacao ?? null}::date,
      ${l.status ?? 'PREVISTO'}::status_lancamento_enum, ${l.cartao ?? false}, ${l.grupo ?? null}, ${l.usuarioId ?? null},
      ${l.status === 'LIQUIDADO' ? l.usuarioId ?? null : null}, ${l.despesaRecorrenteId ?? null}, ${l.mesReferencia ?? null}::date,
      ${l.observacoes ?? null})
    RETURNING id`);
  return r!.id;
}

/** Plano de recebimento do pedido (sinal + saldo). Não faz nada se o pedido já tem cobranças. */
export async function criarPlanoRecebimento(db: Exec, pedidoId: string, usuarioId: string | null = null) {
  const p = await pedidoFin(db, pedidoId);
  const [ja] = await linhas<{ n: number }>(db, sql`
    SELECT COUNT(*)::int AS n FROM lancamentos_financeiros WHERE pedido_id = ${pedidoId} AND tipo = 'RECEITA'`);
  if (ja!.n > 0) return;
  const total = d(p.valorTotal);
  if (total.lte(0)) return;
  const hoje = hojeLoja();
  const base = { lojaId: p.lojaId, tipo: 'RECEITA' as const, planoConta: '1.01', competencia: p.dataVenda, pedidoId, clienteId: p.clienteId, usuarioId };
  const cartao = p.forma != null && ['CREDITO_AVISTA', 'CREDITO_PARCELADO'].includes(p.forma);
  const pct = cartao ? d(100) : d((await parametro(db as Banco, p.lojaId, 'SINAL_PADRAO_PCT')) ?? 50);
  const taxa = await taxaDe(db, p.forma, p.parcelas);
  const sinal = dinheiro(total.mul(pct).div(100));
  const saldo = total.minus(sinal);
  if (sinal.gt(0)) {
    const desc = cartao ? `Pedido ${p.numero} - pagamento no cartão` : `Pedido ${p.numero} - sinal (${pct.toFixed(0)}%)`;
    await inserirLancamento(db, { ...base, origem: 'SINAL', descricao: desc, valor: sinal, taxa: valorTaxa(sinal, taxa), vencimento: hoje, forma: p.forma });
  }
  if (saldo.gt(0)) {
    await inserirLancamento(db, {
      ...base, origem: 'SALDO', descricao: `Pedido ${p.numero} - saldo na instalação`, valor: saldo,
      taxa: valorTaxa(saldo, taxa), vencimento: await vencimentoSaldo(db, p), forma: p.forma,
    });
  }
}

type Aberto = { id: string; origem: string; valor: string; vencimento: string; forma: string | null; editado: boolean };

async function cobrancasAbertas(db: Exec, pedidoId: string, primeiro?: string): Promise<Aberto[]> {
  return linhas<Aberto>(db, sql`
    SELECT id, origem, valor_bruto::text AS valor, to_char(data_vencimento, 'YYYY-MM-DD') AS vencimento,
           forma_pagamento AS forma, editado_manual AS editado
      FROM lancamentos_financeiros
     WHERE pedido_id = ${pedidoId} AND tipo = 'RECEITA' AND status = 'PREVISTO' AND NOT cartao
     ORDER BY (id = ${primeiro ?? null}::uuid) DESC NULLS LAST, data_vencimento, criado_em
     FOR UPDATE`);
}

/** Muda o valor de uma cobrança em aberto (recalcula a taxa prevista). Zero = apaga. */
async function mudarValorCobranca(db: Exec, id: string, novo: Decimal) {
  if (novo.lte(0)) { await db.execute(sql`DELETE FROM lancamentos_financeiros WHERE id = ${id}`); return; }
  const [l] = await linhas<{ forma: string | null; parcelas: number }>(db, sql`
    SELECT forma_pagamento AS forma, total_parcelas AS parcelas FROM lancamentos_financeiros WHERE id = ${id}`);
  const t = valorTaxa(novo, await taxaDe(db, l!.forma, l!.parcelas));
  await db.execute(sql`UPDATE lancamentos_financeiros SET valor_bruto = ${novo.toFixed(2)}, taxa_transacao = ${t.toFixed(2)},
    valor_liquido = ${novo.minus(t).toFixed(2)}, atualizado_em = NOW() WHERE id = ${id}`);
}

export type EntradaRecebimento = {
  valor: string; forma: string; parcelas?: number; data: string; contaFinanceiraId?: string | null; lancamentoId?: string | null;
};

/**
 * Recebe do cliente: baixa as cobranças em aberto do pedido, na ordem de vencimento (a escolhida primeiro).
 * Valor menor que a cobrança deixa o resto em aberto. Cartão vira os repasses da maquininha.
 */
export async function receberDoCliente(db: Exec, pedidoId: string, e: EntradaRecebimento, usuarioId: string | null) {
  const p = await pedidoFin(db, pedidoId);
  if (p.status === 'CANCELADO') throw new ErroFinanceiro('Pedido cancelado: não recebe mais.', 409);
  const abertas = await cobrancasAbertas(db, pedidoId, e.lancamentoId ?? undefined);
  if (e.lancamentoId && abertas[0]?.id !== e.lancamentoId) throw new ErroFinanceiro('Esta cobrança não está em aberto.', 409);
  const valor = d(e.valor);
  if (valor.lte(0)) throw new ErroFinanceiro('Informe o valor recebido.');
  const emAberto = abertas.reduce((s, a) => s.plus(d(a.valor)), d(0));
  if (valor.gt(emAberto)) {
    throw new ErroFinanceiro(`O valor é maior que o saldo em aberto do cliente (R$ ${emAberto.toFixed(2)}).`, 409);
  }
  let falta = valor;
  let origem = 'RECEBIDO';
  for (const a of abertas) {
    if (falta.lte(0)) break;
    if (origem === 'RECEBIDO') origem = a.origem;
    const v = d(a.valor);
    const usa = v.lte(falta) ? v : falta;
    await mudarValorCobranca(db, a.id, v.minus(usa));
    falta = falta.minus(usa);
  }
  const rotulo = origem === 'SINAL' ? 'sinal recebido' : origem === 'SALDO' ? 'saldo recebido' : 'recebido';
  const base = {
    lojaId: p.lojaId, tipo: 'RECEITA' as const, planoConta: '1.01', competencia: p.dataVenda, pedidoId, clienteId: p.clienteId,
    forma: e.forma, usuarioId, contaFinanceiraId: e.contaFinanceiraId ?? null,
  };
  const grupo = randomUUID();
  if (FORMAS_CARTAO.includes(e.forma)) {
    const n = e.forma === 'CREDITO_PARCELADO' ? Math.max(2, e.parcelas ?? 2) : 1;
    const t = await taxaDe(db, e.forma, n);
    const taxaTotal = valorTaxa(valor, t);
    // Com antecipação a operadora deposita tudo de uma vez; sem, uma parcela a cada 30 dias.
    const repasses = t.antecipPct.gt(0) ? 1 : n;
    const brutos = ratear(valor, repasses);
    const taxas = ratear(taxaTotal, repasses);
    for (let k = 0; k < repasses; k++) {
      await inserirLancamento(db, {
        ...base, origem: 'CARTAO', cartao: true, grupo,
        descricao: `Pedido ${p.numero} - ${rotulo} no ${NOME_FORMA[e.forma]!.toLowerCase()}${repasses > 1 ? ` (repasse ${k + 1}/${repasses})` : n > 1 ? ` em ${n}x (antecipado)` : ''}`,
        valor: brutos[k]!, taxa: taxas[k]!, vencimento: somarDias(e.data, t.diasRepasse + 30 * k),
        parcela: k + 1, totalParcelas: repasses,
      });
    }
  } else {
    const t = await taxaDe(db, e.forma, 1);
    await inserirLancamento(db, {
      ...base, origem: 'RECEBIDO', grupo, descricao: `Pedido ${p.numero} - ${rotulo} (${NOME_FORMA[e.forma] ?? e.forma})`,
      valor, taxa: valorTaxa(valor, t), vencimento: e.data, status: 'LIQUIDADO', liquidacao: e.data,
    });
  }
  await liquidarRepassesVencidos(db);
  return { grupo, emAbertoDepois: emAberto.minus(valor).toFixed(2) };
}

/** Repasse da maquininha cai sozinho no dia do vencimento [suposição: a operadora paga em dia]. */
export async function liquidarRepassesVencidos(db: Exec) {
  await db.execute(sql`UPDATE lancamentos_financeiros l SET status = 'LIQUIDADO', data_liquidacao = data_vencimento, atualizado_em = NOW(),
      conta_id = COALESCE(l.conta_id, (SELECT c.id FROM contas_financeiras c WHERE c.loja_id = l.loja_id AND c.ativo
                                        ORDER BY (c.tipo = 'CONTA_CORRENTE') DESC, c.nome LIMIT 1))
    WHERE cartao AND status = 'PREVISTO' AND data_vencimento <= ${hojeLoja()}::date`);
}

/** Desfaz um recebimento (lançado errado): o valor volta a ser cobrança em aberto do cliente. */
export async function estornarRecebimento(db: Exec, lancamentoId: string, usuarioId: string | null) {
  const [l] = await linhas<{ id: string; pedidoId: string | null; grupo: string | null; origem: string; tipo: string; status: string }>(db, sql`
    SELECT id, pedido_id AS "pedidoId", grupo_pagamento_id AS grupo, origem, tipo, status FROM lancamentos_financeiros WHERE id = ${lancamentoId} FOR UPDATE`);
  if (!l || l.tipo !== 'RECEITA' || !l.pedidoId || !['RECEBIDO', 'CARTAO'].includes(l.origem)) {
    throw new ErroFinanceiro('Só dá para desfazer um recebimento de pedido.', 409);
  }
  const grupo = await linhas<{ id: string; valor: string }>(db, sql`
    SELECT id, valor_bruto::text AS valor FROM lancamentos_financeiros
     WHERE ${l.grupo ? sql`grupo_pagamento_id = ${l.grupo}` : sql`id = ${l.id}`} AND status <> 'CANCELADO'`);
  const total = grupo.reduce((s, g) => s.plus(d(g.valor)), d(0));
  await db.execute(sql`DELETE FROM lancamentos_financeiros WHERE id IN (${sql.join(grupo.map((g) => sql`${g.id}::uuid`), sql`, `)})`);
  const p = await pedidoFin(db, l.pedidoId);
  await inserirLancamento(db, {
    lojaId: p.lojaId, tipo: 'RECEITA', origem: 'SALDO', planoConta: '1.01', competencia: p.dataVenda, pedidoId: p.id, clienteId: p.clienteId,
    descricao: `Pedido ${p.numero} - recebimento desfeito, volta a cobrar`, valor: total, vencimento: hojeLoja(), forma: p.forma, usuarioId,
  });
  return { pedidoId: p.id, valor: total.toFixed(2) };
}

/** Aditivo confirmado: a diferença de valor entra (ou sai) das cobranças em aberto. */
export async function ajustarPorAditivo(db: Exec, pedidoId: string, diferenca: Decimal, aditivoNumero: number, usuarioId: string | null) {
  if (diferenca.isZero()) return [] as string[];
  const p = await pedidoFin(db, pedidoId);
  const abertas = await cobrancasAbertas(db, pedidoId);
  const avisos: string[] = [];
  if (diferenca.gt(0)) {
    const ultima = abertas[abertas.length - 1];
    if (ultima) await mudarValorCobranca(db, ultima.id, d(ultima.valor).plus(diferenca));
    else {
      await inserirLancamento(db, {
        lojaId: p.lojaId, tipo: 'RECEITA', origem: 'ADITIVO', planoConta: '1.01', competencia: p.dataVenda, pedidoId, clienteId: p.clienteId,
        descricao: `Pedido ${p.numero} - aditivo ${aditivoNumero}`, valor: diferenca, vencimento: await vencimentoSaldo(db, p), forma: p.forma, usuarioId,
      });
    }
    return avisos;
  }
  let falta = diferenca.abs();
  for (const a of [...abertas].reverse()) {
    if (falta.lte(0)) break;
    const v = d(a.valor);
    const tira = v.lte(falta) ? v : falta;
    await mudarValorCobranca(db, a.id, v.minus(tira));
    falta = falta.minus(tira);
  }
  if (falta.gt(0)) {
    await inserirLancamento(db, {
      lojaId: p.lojaId, tipo: 'DESPESA', origem: 'DEVOLUCAO', planoConta: '2.03', competencia: hojeLoja(), pedidoId, clienteId: p.clienteId,
      descricao: `Pedido ${p.numero} - devolver ao cliente (aditivo ${aditivoNumero})`, valor: falta, vencimento: hojeLoja(), usuarioId,
    });
    avisos.push(`O cliente já pagou R$ ${falta.toFixed(2)} a mais: ficou em Contas a pagar como devolução.`);
  }
  return avisos;
}

/** Saldo do cliente vence na instalação: ao agendar (ou mudar a previsão), acompanha a data. */
export async function atualizarVencimentoSaldo(db: Exec, pedidoId: string) {
  const p = await pedidoFin(db, pedidoId);
  const venc = await vencimentoSaldo(db, p);
  await db.execute(sql`UPDATE lancamentos_financeiros SET data_vencimento = ${venc}::date, atualizado_em = NOW()
    WHERE pedido_id = ${pedidoId} AND tipo = 'RECEITA' AND origem IN ('SALDO', 'ADITIVO') AND status = 'PREVISTO'
      AND NOT cartao AND NOT editado_manual`);
}

/** Resumo do que o cliente pagou e deve (o que o vendedor vê no pedido). */
export async function situacaoCliente(db: Exec, pedidoId: string) {
  const [r] = await linhas<{ n: number; aberto: string; pago: string; vencido: string }>(db, sql`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(valor_bruto) FILTER (WHERE status = 'PREVISTO' AND NOT cartao), 0)::text AS aberto,
           COALESCE(SUM(valor_bruto) FILTER (WHERE status = 'LIQUIDADO' OR cartao), 0)::text AS pago,
           COALESCE(SUM(valor_bruto) FILTER (WHERE status = 'PREVISTO' AND NOT cartao AND data_vencimento < ${hojeLoja()}::date), 0)::text AS vencido
      FROM lancamentos_financeiros WHERE pedido_id = ${pedidoId} AND tipo = 'RECEITA' AND status <> 'CANCELADO'`);
  return r!.n > 0 ? { temPlano: true, aberto: r!.aberto, pago: r!.pago, vencido: r!.vencido } : { temPlano: false, aberto: '0', pago: '0', vencido: '0' };
}

// ------------------------------------------------------------------ contas a pagar geradas pelo pedido

/** Conta a pagar da ordem de compra acompanha a ordem (valor, fornecedor, previsão, cancelamento). */
export async function sincronizarPagarOrdem(db: Exec, ordemId: string, usuarioId: string | null = null) {
  const [o] = await linhas<{
    id: string; numero: string; lojaId: string; pedidoId: string; pedidoNumero: string; fornecedorId: string | null; tipo: string;
    status: string; valor: string; previsao: string | null; criada: string; dataVenda: string; categoria: number | null;
  }>(db, sql`
    SELECT o.id, o.numero, o.loja_id AS "lojaId", o.pedido_id AS "pedidoId", p.numero_pedido AS "pedidoNumero", o.fornecedor_id AS "fornecedorId",
           o.tipo, o.status, COALESCE(o.custo_real, o.custo_previsto)::text AS valor, to_char(o.previsao_entrega, 'YYYY-MM-DD') AS previsao,
           to_char((o.criado_em AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS criada,
           to_char((p.data_compra AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS "dataVenda",
           (SELECT pr.categoria_id FROM ordem_compra_itens it JOIN produtos pr ON pr.id = it.produto_id
             WHERE it.ordem_id = o.id GROUP BY pr.categoria_id ORDER BY SUM(it.custo_total) DESC LIMIT 1) AS categoria
      FROM ordens_compra o JOIN pedidos p ON p.id = o.pedido_id WHERE o.id = ${ordemId}`);
  if (!o) return;
  const [l] = await linhas<{ id: string; status: string; editado: boolean }>(db, sql`
    SELECT id, status, editado_manual AS editado FROM lancamentos_financeiros WHERE ordem_compra_id = ${ordemId}
     ORDER BY (status = 'CANCELADO'), criado_em LIMIT 1 FOR UPDATE`);
  if (o.status === 'CANCELADA') {
    if (l?.status === 'PREVISTO') await db.execute(sql`UPDATE lancamentos_financeiros SET status = 'CANCELADO', atualizado_em = NOW() WHERE id = ${l.id}`);
    return;
  }
  const valor = d(o.valor);
  // [suposição] Paga-se o fornecedor na entrega: vence na previsão de entrega da ordem.
  const venc = o.previsao ?? o.criada;
  const quem = o.tipo === 'COSTURA' ? 'costura' : o.tipo === 'FABRICA' ? 'fábrica' : 'compra';
  if (!l) {
    if (valor.lte(0)) return;
    const conta = o.tipo === 'COSTURA' ? '3.04' : o.tipo === 'FABRICA' ? '3.02' : CONTA_CMV_DA_CATEGORIA[o.categoria ?? 0] ?? '3.03';
    await inserirLancamento(db, {
      lojaId: o.lojaId, tipo: 'DESPESA', origem: 'ORDEM_COMPRA', planoConta: conta, descricao: `${o.numero} (${quem}) - pedido ${o.pedidoNumero}`,
      valor, competencia: o.dataVenda, vencimento: venc, pedidoId: o.pedidoId, fornecedorId: o.fornecedorId, ordemCompraId: o.id, usuarioId,
    });
    return;
  }
  if (l.status === 'CANCELADO') {
    await db.execute(sql`UPDATE lancamentos_financeiros SET status = 'PREVISTO', atualizado_em = NOW() WHERE id = ${l.id}`);
  }
  if (l.status === 'LIQUIDADO' || l.editado) return;
  await db.execute(sql`UPDATE lancamentos_financeiros SET valor_bruto = ${valor.toFixed(2)}, valor_liquido = ${valor.toFixed(2)},
    fornecedor_id = ${o.fornecedorId}, data_vencimento = ${venc}::date, atualizado_em = NOW() WHERE id = ${l.id}`);
}

/** Custo da instalação do pedido = componentes da categoria "Serviços de instalação". */
async function custoInstalacao(db: Exec, orcamentoId: string): Promise<Decimal> {
  const [r] = await linhas<{ v: string }>(db, sql`
    SELECT COALESCE(SUM(oc.custo_total), 0)::text AS v FROM orcamento_itens_compostos i
      JOIN orcamento_componentes oc ON oc.item_composto_id = i.id JOIN produtos pr ON pr.id = oc.produto_id
     WHERE i.orcamento_id = ${orcamentoId} AND pr.categoria_id = ${CATEGORIA_INSTALACAO}`);
  return d(r!.v);
}

/** Conta a pagar do instalador terceirizado: nasce ao agendar e acompanha data, instalador e aditivos. */
export async function sincronizarPagarInstalacao(db: Exec, pedidoId: string, usuarioId: string | null = null) {
  const [p] = await linhas<{ lojaId: string; numero: string; status: string; instalador: string | null; quando: string | null; orcamentoId: string; dataVenda: string }>(db, sql`
    SELECT loja_id AS "lojaId", numero_pedido AS numero, status_operacional AS status, instalador_fornecedor_id AS instalador,
           to_char((COALESCE(data_instalacao_realizada, data_instalacao_agendada) AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS quando,
           orcamento_id AS "orcamentoId", to_char((data_compra AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS "dataVenda"
      FROM pedidos WHERE id = ${pedidoId}`);
  if (!p) return;
  const [l] = await linhas<{ id: string; status: string; editado: boolean }>(db, sql`
    SELECT id, status, editado_manual AS editado FROM lancamentos_financeiros
     WHERE pedido_id = ${pedidoId} AND origem = 'INSTALACAO' AND status <> 'CANCELADO' ORDER BY criado_em LIMIT 1 FOR UPDATE`);
  if (p.status === 'CANCELADO') {
    if (l?.status === 'PREVISTO') await db.execute(sql`UPDATE lancamentos_financeiros SET status = 'CANCELADO', atualizado_em = NOW() WHERE id = ${l.id}`);
    return;
  }
  if (!p.instalador) return;
  const valor = await custoInstalacao(db, p.orcamentoId);
  const venc = p.quando ?? hojeLoja();
  if (!l) {
    if (valor.lte(0)) return;
    await inserirLancamento(db, {
      lojaId: p.lojaId, tipo: 'DESPESA', origem: 'INSTALACAO', planoConta: '3.05', descricao: `Instalação do pedido ${p.numero}`,
      valor, competencia: p.dataVenda, vencimento: venc, pedidoId, fornecedorId: p.instalador, usuarioId,
    });
    return;
  }
  if (l.status === 'LIQUIDADO' || l.editado) return;
  if (valor.lte(0)) { await db.execute(sql`UPDATE lancamentos_financeiros SET status = 'CANCELADO', atualizado_em = NOW() WHERE id = ${l.id}`); return; }
  await db.execute(sql`UPDATE lancamentos_financeiros SET valor_bruto = ${valor.toFixed(2)}, valor_liquido = ${valor.toFixed(2)},
    fornecedor_id = ${p.instalador}, data_vencimento = ${venc}::date, atualizado_em = NOW() WHERE id = ${l.id}`);
}

/** Comissão do vendedor (cadastro da equipe). Vence na previsão de entrega [suposição]. */
export async function sincronizarComissao(db: Exec, pedidoId: string, usuarioId: string | null = null) {
  const [p] = await linhas<{ lojaId: string; numero: string; status: string; vendedorId: string; vendedor: string; comissao: string; previsao: string | null; dataVenda: string }>(db, sql`
    SELECT p.loja_id AS "lojaId", p.numero_pedido AS numero, p.status_operacional AS status, p.vendedor_id AS "vendedorId", u.nome AS vendedor,
           o.comissao_valor::text AS comissao, to_char(p.data_previsao_entrega, 'YYYY-MM-DD') AS previsao,
           to_char((p.data_compra AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS "dataVenda"
      FROM pedidos p JOIN orcamentos o ON o.id = p.orcamento_id JOIN usuarios u ON u.id = p.vendedor_id WHERE p.id = ${pedidoId}`);
  if (!p) return;
  const [l] = await linhas<{ id: string; status: string; editado: boolean }>(db, sql`
    SELECT id, status, editado_manual AS editado FROM lancamentos_financeiros
     WHERE pedido_id = ${pedidoId} AND origem = 'COMISSAO' AND status <> 'CANCELADO' ORDER BY criado_em LIMIT 1 FOR UPDATE`);
  const valor = d(p.comissao);
  if (p.status === 'CANCELADO' || valor.lte(0)) {
    if (l?.status === 'PREVISTO' && !l.editado) await db.execute(sql`UPDATE lancamentos_financeiros SET status = 'CANCELADO', atualizado_em = NOW() WHERE id = ${l.id}`);
    return;
  }
  const venc = p.previsao ?? somarDias(hojeLoja(), 30);
  if (!l) {
    await inserirLancamento(db, {
      lojaId: p.lojaId, tipo: 'DESPESA', origem: 'COMISSAO', planoConta: '4.01', descricao: `Comissão de ${p.vendedor} - pedido ${p.numero}`,
      valor, competencia: p.dataVenda, vencimento: venc, pedidoId, vendedorId: p.vendedorId, usuarioId,
    });
    return;
  }
  if (l.status === 'LIQUIDADO' || l.editado) return;
  await db.execute(sql`UPDATE lancamentos_financeiros SET valor_bruto = ${valor.toFixed(2)}, valor_liquido = ${valor.toFixed(2)},
    data_vencimento = ${venc}::date, atualizado_em = NOW() WHERE id = ${l.id}`);
}

/** Pedido cancelado: cancela o que ainda não aconteceu. Devolve quanto o cliente já pagou (para avisar). */
export async function cancelarFinanceiroPedido(db: Exec, pedidoId: string) {
  await db.execute(sql`UPDATE lancamentos_financeiros SET status = 'CANCELADO', atualizado_em = NOW()
    WHERE pedido_id = ${pedidoId} AND status = 'PREVISTO' AND NOT cartao
      AND (tipo = 'RECEITA' OR origem IN ('INSTALACAO', 'COMISSAO'))`);
  const s = await situacaoCliente(db, pedidoId);
  return d(s.pago);
}

// ------------------------------------------------------------------ rotina (roda ao abrir o financeiro)

/**
 * Coloca o financeiro em dia: despesas fixas do mês, repasses de cartão que já caíram e pedidos antigos
 * (feitos antes do módulo financeiro) que ainda não têm cobranças e contas a pagar.
 */
export async function rotinaFinanceira(db: Banco, lojaId: string) {
  const hoje = hojeLoja();
  await db.transaction(async (tx) => {
    // Uma rotina por vez (duas abas abertas não lançam em dobro).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727006)`);
    await liquidarRepassesVencidos(tx);

    // Despesas fixas: do mês de início até o mês que vem.
    const recorrentes = await linhas<{ id: number; descricao: string; conta: string; fornecedorId: string | null; valor: string; dia: number; inicio: string }>(tx, sql`
      SELECT r.id, r.descricao, pc.codigo AS conta, r.fornecedor_id AS "fornecedorId", r.valor::text AS valor, r.dia_vencimento AS dia,
             to_char(date_trunc('month', r.inicio), 'YYYY-MM-DD') AS inicio
        FROM despesas_recorrentes r JOIN plano_contas pc ON pc.id = r.plano_conta_id
       WHERE r.loja_id = ${lojaId} AND r.ativo AND r.valor > 0`);
    const [ano, mes] = hoje.split('-').map(Number);
    const fim = new Date(Date.UTC(ano!, mes!, 1)); // 1º dia do mês que vem
    for (const r of recorrentes) {
      const ini = r.inicio.split('-').map(Number);
      for (let x = new Date(Date.UTC(ini[0]!, ini[1]! - 1, 1)); x <= fim; x.setUTCMonth(x.getUTCMonth() + 1)) {
        const ref = x.toISOString().slice(0, 10);
        const venc = `${ref.slice(0, 8)}${String(r.dia).padStart(2, '0')}`;
        const [ja] = await linhas<{ n: number }>(tx, sql`
          SELECT COUNT(*)::int AS n FROM lancamentos_financeiros WHERE despesa_recorrente_id = ${r.id} AND mes_referencia = ${ref}::date`);
        if (ja!.n > 0) continue;
        await inserirLancamento(tx, {
          lojaId, tipo: 'DESPESA', origem: 'RECORRENTE', planoConta: r.conta,
          descricao: `${r.descricao} - ${ref.slice(5, 7)}/${ref.slice(0, 4)}`, valor: d(r.valor), competencia: venc, vencimento: venc,
          fornecedorId: r.fornecedorId, despesaRecorrenteId: r.id, mesReferencia: ref,
        });
      }
    }

    // Pedidos de antes do financeiro: plano de recebimento (com o sinal já registrado), compras, instalador e comissão.
    const semPlano = await linhas<{ id: string; sinal: string | null; forma: string | null; data: string | null }>(tx, sql`
      SELECT p.id, p.sinal_valor::text AS sinal, p.sinal_forma AS forma, to_char(p.sinal_recebido_em, 'YYYY-MM-DD') AS data
        FROM pedidos p WHERE p.loja_id = ${lojaId} AND p.status_operacional <> 'CANCELADO'
         AND NOT EXISTS (SELECT 1 FROM lancamentos_financeiros l WHERE l.pedido_id = p.id AND l.tipo = 'RECEITA')`);
    for (const p of semPlano) {
      await criarPlanoRecebimento(tx, p.id);
      if (p.sinal && d(p.sinal).gt(0) && p.forma && p.forma !== 'MISTO') {
        const s = await situacaoCliente(tx, p.id);
        const valor = d(p.sinal).gt(d(s.aberto)) ? d(s.aberto) : d(p.sinal);
        if (valor.gt(0)) await receberDoCliente(tx, p.id, { valor: valor.toFixed(2), forma: p.forma, data: p.data ?? hoje }, null);
      }
      await sincronizarComissao(tx, p.id);
    }
    const ordensSem = await linhas<{ id: string }>(tx, sql`
      SELECT o.id FROM ordens_compra o WHERE o.loja_id = ${lojaId} AND o.status <> 'CANCELADA'
         AND NOT EXISTS (SELECT 1 FROM lancamentos_financeiros l WHERE l.ordem_compra_id = o.id)`);
    for (const o of ordensSem) await sincronizarPagarOrdem(tx, o.id);
    const instSem = await linhas<{ id: string }>(tx, sql`
      SELECT p.id FROM pedidos p WHERE p.loja_id = ${lojaId} AND p.instalador_fornecedor_id IS NOT NULL AND p.status_operacional <> 'CANCELADO'
         AND NOT EXISTS (SELECT 1 FROM lancamentos_financeiros l WHERE l.pedido_id = p.id AND l.origem = 'INSTALACAO')`);
    for (const p of instSem) await sincronizarPagarInstalacao(tx, p.id);
  });
}

// ------------------------------------------------------------------ lucro real por pedido

export type LucroPedido = {
  pedidoId: string; numero: string; cliente: string; vendedor: string; status: string; dataVenda: string;
  venda: string; custoPrevisto: string; custoReal: string; custoEstimado: boolean; desvio: string;
  taxas: string; imposto: string; comissao: string; lucro: string; margemPct: string;
  margemPrevistaPct: string; alertas: string[];
};

/**
 * Lucro líquido real (11.1 item 2): venda - CMV real - taxas - imposto - comissão.
 * CMV real = contas a pagar das ordens de compra (ou o previsto, enquanto não houver compras) + instalador
 * (ou o previsto, enquanto não agendado) + outros custos lançados no pedido (ex.: refação).
 */
export async function lucroPedidos(db: Exec, pedidoIds: string[], lojaId: string): Promise<LucroPedido[]> {
  if (pedidoIds.length === 0) return [];
  const ids = sql`ARRAY[${sql.join(pedidoIds.map((i) => sql`${i}::uuid`), sql`, `)}]`;
  const rows = await linhas<{
    pedidoId: string; numero: string; cliente: string; vendedor: string; status: string; dataVenda: string; venda: string;
    custoPrevisto: string; prevInstal: string; nOc: number; ocReal: string; nInst: number; instReal: string; outros: string;
    taxas: string; comissaoLanc: string; nComissao: number; comissaoOrc: string; margemPrevista: string;
  }>(db, sql`
    WITH ped AS (
      SELECT p.id, p.numero_pedido, p.valor_total_final, p.status_operacional, p.data_compra, p.orcamento_id,
             c.nome_completo, u.nome AS vendedor, o.custo_total_previsto, o.comissao_valor, o.margem_prevista_pct
        FROM pedidos p JOIN orcamentos o ON o.id = p.orcamento_id JOIN clientes c ON c.id = p.cliente_id JOIN usuarios u ON u.id = p.vendedor_id
       WHERE p.id = ANY(${ids}) AND p.loja_id = ${lojaId}),
    inst AS (
      SELECT ped.id, COALESCE(SUM(oc.custo_total), 0) AS v FROM ped
        JOIN orcamento_itens_compostos i ON i.orcamento_id = ped.orcamento_id
        JOIN orcamento_componentes oc ON oc.item_composto_id = i.id JOIN produtos pr ON pr.id = oc.produto_id
       WHERE pr.categoria_id = ${CATEGORIA_INSTALACAO} GROUP BY ped.id),
    lanc AS (
      SELECT l.pedido_id,
             COUNT(*) FILTER (WHERE l.ordem_compra_id IS NOT NULL AND l.status <> 'CANCELADO')::int AS n_oc,
             COALESCE(SUM(l.valor_bruto) FILTER (WHERE l.ordem_compra_id IS NOT NULL AND l.status <> 'CANCELADO'), 0) AS oc_real,
             COUNT(*) FILTER (WHERE l.origem = 'INSTALACAO' AND l.status <> 'CANCELADO')::int AS n_inst,
             COALESCE(SUM(l.valor_bruto) FILTER (WHERE l.origem = 'INSTALACAO' AND l.status <> 'CANCELADO'), 0) AS inst_real,
             COALESCE(SUM(l.valor_bruto) FILTER (WHERE l.tipo = 'DESPESA' AND pc.grupo_dre = 'CMV' AND l.ordem_compra_id IS NULL
               AND l.origem <> 'INSTALACAO' AND l.status <> 'CANCELADO'), 0) AS outros,
             COALESCE(SUM(l.taxa_transacao) FILTER (WHERE l.tipo = 'RECEITA' AND l.status <> 'CANCELADO'), 0) AS taxas,
             COUNT(*) FILTER (WHERE l.origem = 'COMISSAO' AND l.status <> 'CANCELADO')::int AS n_com,
             COALESCE(SUM(l.valor_bruto) FILTER (WHERE l.origem = 'COMISSAO' AND l.status <> 'CANCELADO'), 0) AS comissao
        FROM lancamentos_financeiros l JOIN plano_contas pc ON pc.id = l.plano_conta_id
       WHERE l.pedido_id = ANY(${ids}) GROUP BY l.pedido_id)
    SELECT ped.id AS "pedidoId", ped.numero_pedido AS numero, ped.nome_completo AS cliente, ped.vendedor, ped.status_operacional AS status,
           to_char((ped.data_compra AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS "dataVenda",
           ped.valor_total_final::text AS venda, ped.custo_total_previsto::text AS "custoPrevisto", COALESCE(inst.v, 0)::text AS "prevInstal",
           COALESCE(lanc.n_oc, 0) AS "nOc", COALESCE(lanc.oc_real, 0)::text AS "ocReal",
           COALESCE(lanc.n_inst, 0) AS "nInst", COALESCE(lanc.inst_real, 0)::text AS "instReal", COALESCE(lanc.outros, 0)::text AS outros,
           COALESCE(lanc.taxas, 0)::text AS taxas, COALESCE(lanc.comissao, 0)::text AS "comissaoLanc", COALESCE(lanc.n_com, 0) AS "nComissao",
           ped.comissao_valor::text AS "comissaoOrc", ped.margem_prevista_pct::text AS "margemPrevista"
      FROM ped LEFT JOIN inst ON inst.id = ped.id LEFT JOIN lanc ON lanc.pedido_id = ped.id
     ORDER BY ped.data_compra, ped.numero_pedido`);
  const aliquota = d((await parametro(db as Banco, lojaId, 'ALIQUOTA_IMPOSTO_VENDA_PCT')) ?? 0);
  const amarelo = d((await parametro(db as Banco, lojaId, 'SEMAFORO_AMARELO_MIN_PCT')) ?? 35);
  return rows.map((r) => {
    const venda = d(r.venda);
    const prev = d(r.custoPrevisto);
    const prevInst = d(r.prevInstal);
    const compras = r.nOc > 0 ? d(r.ocReal) : prev.minus(prevInst);
    const instal = r.nInst > 0 ? d(r.instReal) : prevInst;
    const estimado = r.nOc === 0 || (r.nInst === 0 && prevInst.gt(0));
    const custoReal = compras.plus(instal).plus(d(r.outros));
    const imposto = dinheiro(venda.mul(aliquota).div(100));
    const comissao = r.nComissao > 0 ? d(r.comissaoLanc) : d(r.comissaoOrc);
    const lucro = venda.minus(custoReal).minus(d(r.taxas)).minus(imposto).minus(comissao);
    const margem = venda.gt(0) ? lucro.div(venda).mul(100) : d(0);
    const desvio = custoReal.minus(prev);
    const alertas: string[] = [];
    if (margem.lt(amarelo)) alertas.push(`Margem abaixo de ${amarelo.toFixed(0)}%`);
    if (!estimado && prev.gt(0) && desvio.div(prev).mul(100).gt(5)) alertas.push(`Custo real ${desvio.div(prev).mul(100).toFixed(1).replace('.', ',')}% acima do previsto`);
    return {
      pedidoId: r.pedidoId, numero: r.numero, cliente: r.cliente, vendedor: r.vendedor, status: r.status, dataVenda: r.dataVenda,
      venda: venda.toFixed(2), custoPrevisto: prev.toFixed(2), custoReal: custoReal.toFixed(2), custoEstimado: estimado,
      desvio: desvio.toFixed(2), taxas: d(r.taxas).toFixed(2), imposto: imposto.toFixed(2), comissao: comissao.toFixed(2),
      lucro: lucro.toFixed(2), margemPct: margem.toFixed(2), margemPrevistaPct: d(r.margemPrevista).toFixed(2), alertas,
    };
  });
}

// ------------------------------------------------------------------ limite do MEI

/**
 * Faturamento do ano x limite do MEI. Considera o maior entre o vendido (pedidos do ano) e o recebido
 * no ano [suposição conservadora: o contador confirma qual vale para a declaração].
 */
export async function situacaoMei(db: Exec, lojaId: string, hoje = hojeLoja()) {
  const ano = hoje.slice(0, 4);
  const limite = d((await parametro(db as Banco, lojaId, 'LIMITE_FATURAMENTO_ANUAL_MEI')) ?? 81000);
  const alertaPct = d((await parametro(db as Banco, lojaId, 'ALERTA_LIMITE_MEI_PCT')) ?? 80);
  const [r] = await linhas<{ vendido: string; recebido: string }>(db, sql`
    SELECT
      (SELECT COALESCE(SUM(valor_total_final), 0) FROM pedidos WHERE loja_id = ${lojaId} AND status_operacional <> 'CANCELADO'
          AND (data_compra AT TIME ZONE ${FUSO})::date BETWEEN ${`${ano}-01-01`}::date AND ${`${ano}-12-31`}::date)::text AS vendido,
      (SELECT COALESCE(SUM(l.valor_bruto), 0) FROM lancamentos_financeiros l JOIN plano_contas pc ON pc.id = l.plano_conta_id
        WHERE l.loja_id = ${lojaId} AND l.tipo = 'RECEITA' AND pc.grupo_dre = 'RECEITA'
          AND (l.status = 'LIQUIDADO' OR l.cartao) AND l.status <> 'CANCELADO'
          AND COALESCE(l.data_liquidacao, l.data_competencia) BETWEEN ${`${ano}-01-01`}::date AND ${`${ano}-12-31`}::date)::text AS recebido`);
  const vendido = d(r!.vendido);
  const recebido = d(r!.recebido);
  const base = vendido.gt(recebido) ? vendido : recebido;
  const usadoPct = limite.gt(0) ? base.div(limite).mul(100) : d(0);
  const nivel = usadoPct.gte(100) ? 'ESTOUROU' : usadoPct.gte(alertaPct) ? 'ALERTA' : 'OK';
  const mensagem = nivel === 'ESTOUROU'
    ? `Faturamento do ano passou do limite do MEI (R$ ${limite.toFixed(2)}). Fale com o contador agora: pode ser preciso migrar para o Simples.`
    : nivel === 'ALERTA'
      ? `Atenção: o faturamento do ano já chegou a ${usadoPct.toFixed(0)}% do limite do MEI. Faltam R$ ${limite.minus(base).toFixed(2)}.`
      : null;
  return {
    ano, limite: limite.toFixed(2), alertaPct: alertaPct.toFixed(2), vendido: vendido.toFixed(2), recebido: recebido.toFixed(2),
    usadoPct: usadoPct.toFixed(2), restante: (limite.minus(base).gt(0) ? limite.minus(base) : d(0)).toFixed(2), nivel, mensagem,
  };
}
