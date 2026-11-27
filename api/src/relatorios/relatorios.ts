import { sql, type SQL } from 'drizzle-orm';
import { d, dinheiro, type Decimal } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { parametro } from '../catalogo/parametros.js';
import { hojeLoja } from '../pedidos/dias-uteis.js';
import { CONTA_CMV_DA_CATEGORIA, lucroPedidos, NOME_FORMA, somarDias } from '../financeiro/servico.js';
import { STATUS_PEDIDO } from '../pedidos/servico.js';
import { RELATORIOS, type Filtros, type Kpi, type Linha, type Relatorio, type Tabela, type TipoRelatorio } from './tipos.js';

/** Os 8 relatórios gerenciais (especificação v1.1, seção 11.2). Só ADMIN. */

const FUSO = 'America/Sao_Paulo';
const Z = () => d(0);
const dataVenda = sql`(p.data_compra AT TIME ZONE ${FUSO})::date`;
const br = (iso: string) => iso.split('-').reverse().join('/');
const pctDe = (parte: Decimal, total: Decimal) => (total.isZero() ? d(0) : parte.div(total).mul(100)).toFixed(2);
const soma = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), d(0));

async function linhas<T>(db: Banco, q: SQL): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

function base(tipo: TipoRelatorio, f: Filtros, periodo?: string): Relatorio {
  const meta = RELATORIOS.find((r) => r.id === tipo)!;
  return {
    tipo, titulo: meta.titulo, periodo: periodo ?? `${br(f.de)} a ${br(f.ate)}`,
    geradoEm: new Date().toISOString(), resumo: [], tabelas: [], observacoes: [],
  };
}

export async function gerarRelatorio(db: Banco, lojaId: string, tipo: TipoRelatorio, f: Filtros): Promise<Relatorio> {
  switch (tipo) {
    case 'dre': return dre(db, lojaId, f);
    case 'faturamento': return faturamento(db, lojaId, f);
    case 'rentabilidade': return rentabilidade(db, lojaId, f);
    case 'fluxo-caixa': return fluxoCaixa(db, lojaId, f);
    case 'contas': return contas(db, lojaId, f);
    case 'funil': return funil(db, lojaId, f);
    case 'curva-abc': return curvaAbc(db, lojaId, f);
    case 'clientes': return clientes(db, lojaId, f);
  }
}

// ------------------------------------------------------------------ 1. DRE

async function dre(db: Banco, lojaId: string, f: Filtros): Promise<Relatorio> {
  const caixa = f.regime === 'caixa';
  const r = base('dre', f);
  r.titulo = `DRE gerencial (${caixa ? 'regime de caixa' : 'regime de competência'})`;
  const filtro = caixa
    ? sql`l.status = 'LIQUIDADO' AND l.data_liquidacao BETWEEN ${f.de}::date AND ${f.ate}::date`
    : sql`l.status <> 'CANCELADO' AND l.data_competencia BETWEEN ${f.de}::date AND ${f.ate}::date`;
  const lancs = await linhas<{ tipo: string; pedidoId: string | null; ordemId: string | null; codigo: string; grupo: string; valor: string; taxa: string }>(db, sql`
    SELECT l.tipo, l.pedido_id AS "pedidoId", l.ordem_compra_id AS "ordemId", pc.codigo, pc.grupo_dre AS grupo,
           l.valor_bruto::text AS valor, l.taxa_transacao::text AS taxa
      FROM lancamentos_financeiros l JOIN plano_contas pc ON pc.id = l.plano_conta_id
     WHERE l.loja_id = ${lojaId} AND ${filtro}`);
  const plano = await linhas<{ codigo: string; nome: string; grupo: string }>(db, sql`
    SELECT codigo, nome, grupo_dre AS grupo FROM plano_contas ORDER BY codigo`);
  const v = new Map<string, Decimal>(plano.map((p) => [p.codigo, Z()]));
  const add = (codigo: string, x: Decimal) => v.set(codigo, (v.get(codigo) ?? Z()).plus(x));

  // Receita do pedido dividida entre cortinas (1.01), persianas (1.02) e instalação (1.03) pela composição da venda.
  const pedidos = [...new Set(lancs.filter((l) => l.tipo === 'RECEITA' && l.pedidoId).map((l) => l.pedidoId!))];
  const comp = new Map<string, Record<string, Decimal>>();
  if (pedidos.length) {
    const ids = sql`ARRAY[${sql.join(pedidos.map((i) => sql`${i}::uuid`), sql`, `)}]`;
    const rows = await linhas<{ id: string; conta: string; v: string }>(db, sql`
      SELECT p.id, CASE WHEN pr.categoria_id = 9 THEN '1.03' WHEN i.tipo_item = 'PERSIANA' THEN '1.02' ELSE '1.01' END AS conta,
             SUM(CASE WHEN oc.preco_total_liquido > 0 OR oc.desconto_rateado > 0 THEN oc.preco_total_liquido ELSE oc.preco_total END)::text AS v
        FROM pedidos p JOIN orcamento_itens_compostos i ON i.orcamento_id = p.orcamento_id
        JOIN orcamento_componentes oc ON oc.item_composto_id = i.id LEFT JOIN produtos pr ON pr.id = oc.produto_id
       WHERE p.id = ANY(${ids}) GROUP BY 1, 2`);
    for (const x of rows) comp.set(x.id, { ...(comp.get(x.id) ?? {}), [x.conta]: d(x.v) });
  }
  // CMV das ordens de compra dividido pelas categorias dos itens.
  const ordens = [...new Set(lancs.filter((l) => l.ordemId).map((l) => l.ordemId!))];
  const compOc = new Map<string, Record<string, Decimal>>();
  if (ordens.length) {
    const ids = sql`ARRAY[${sql.join(ordens.map((i) => sql`${i}::uuid`), sql`, `)}]`;
    const rows = await linhas<{ id: string; cat: number | null; v: string }>(db, sql`
      SELECT it.ordem_id AS id, pr.categoria_id AS cat, SUM(it.custo_total)::text AS v
        FROM ordem_compra_itens it LEFT JOIN produtos pr ON pr.id = it.produto_id
       WHERE it.ordem_id = ANY(${ids}) GROUP BY 1, 2`);
    for (const x of rows) {
      const conta = CONTA_CMV_DA_CATEGORIA[x.cat ?? 0] ?? '3.03';
      const m = compOc.get(x.id) ?? {};
      m[conta] = (m[conta] ?? Z()).plus(d(x.v));
      compOc.set(x.id, m);
    }
  }
  const repartir = (valor: Decimal, pesos: Record<string, Decimal> | undefined, padrao: string) => {
    const tot = soma(Object.values(pesos ?? {}));
    if (!pesos || tot.lte(0)) { add(padrao, valor); return; }
    const contas = Object.keys(pesos).sort((a, b) => pesos[b]!.cmp(pesos[a]!));
    let resto = valor;
    for (const c of contas.slice(1)) { const parte = dinheiro(valor.mul(pesos[c]!).div(tot)); add(c, parte); resto = resto.minus(parte); }
    add(contas[0]!, resto);
  };

  let taxas = Z();
  for (const l of lancs) {
    const valor = d(l.valor);
    if (l.tipo === 'RECEITA') {
      taxas = taxas.plus(d(l.taxa));
      if (l.pedidoId && l.grupo === 'RECEITA' && l.codigo === '1.01') repartir(valor, comp.get(l.pedidoId), '1.01');
      else add(l.codigo, valor);
    } else if (l.ordemId && l.grupo === 'CMV') repartir(valor, compOc.get(l.ordemId), l.codigo);
    else add(l.codigo, valor);
  }
  add('2.02', taxas);

  // Competência: o custo acompanha a venda. Pedido do período que ainda não tem as compras (ou o instalador)
  // lançadas entra com o custo previsto do orçamento, para o lucro não aparecer inflado.
  let estimado = Z();
  if (!caixa && pedidos.length) {
    const ids = sql`ARRAY[${sql.join(pedidos.map((i) => sql`${i}::uuid`), sql`, `)}]`;
    const prev = await linhas<{ cat: number | null; v: string }>(db, sql`
      SELECT pr.categoria_id AS cat, SUM(oc.custo_total)::text AS v
        FROM pedidos p JOIN orcamento_itens_compostos i ON i.orcamento_id = p.orcamento_id
        JOIN orcamento_componentes oc ON oc.item_composto_id = i.id LEFT JOIN produtos pr ON pr.id = oc.produto_id
       WHERE p.id = ANY(${ids}) AND p.status_operacional <> 'CANCELADO'
         AND CASE WHEN pr.categoria_id = 9
               THEN NOT EXISTS (SELECT 1 FROM lancamentos_financeiros l WHERE l.pedido_id = p.id AND l.origem = 'INSTALACAO' AND l.status <> 'CANCELADO')
               ELSE NOT EXISTS (SELECT 1 FROM lancamentos_financeiros l WHERE l.pedido_id = p.id AND l.ordem_compra_id IS NOT NULL AND l.status <> 'CANCELADO')
             END
       GROUP BY 1`);
    for (const x of prev) { add(CONTA_CMV_DA_CATEGORIA[x.cat ?? 0] ?? '3.03', d(x.v)); estimado = estimado.plus(d(x.v)); }
  }
  const aliquota = d((await parametro(db, lojaId, 'ALIQUOTA_IMPOSTO_VENDA_PCT')) ?? 0);
  const grupo = (g: string) => plano.filter((p) => p.grupo === g);
  const tot = (g: string) => soma(grupo(g).map((p) => v.get(p.codigo) ?? Z()));
  const receitaBruta = tot('RECEITA');
  const impostoEstimado = dinheiro(receitaBruta.mul(aliquota).div(100));
  add('2.01', impostoEstimado);
  const deducoes = tot('DEDUCAO');
  const liquida = receitaBruta.minus(deducoes);
  const cmv = tot('CMV');
  const lucroBruto = liquida.minus(cmv);
  const variaveis = tot('DESPESA_VARIAVEL');
  const fixas = tot('DESPESA_FIXA');
  const lucro = lucroBruto.minus(variaveis).minus(fixas);

  const out: Linha[] = [];
  const total = (conta: string, valor: Decimal, alerta = false) => out.push({ conta, valor: valor.toFixed(2), pct: pctDe(valor, receitaBruta), _nivel: 0, _alerta: alerta });
  const detalhes = (g: string, sinal: 1 | -1) => {
    for (const p of grupo(g)) {
      const x = v.get(p.codigo) ?? Z();
      if (x.isZero() && p.codigo !== '2.02') continue;
      out.push({ conta: `${p.codigo} ${nomeConta(p.nome)}`, valor: x.mul(sinal).toFixed(2), pct: pctDe(x.mul(sinal), receitaBruta), _nivel: 1 });
    }
  };
  total('RECEITA BRUTA', receitaBruta); detalhes('RECEITA', 1);
  total('(-) IMPOSTOS, TAXAS E DEVOLUÇÕES', deducoes.neg()); detalhes('DEDUCAO', -1);
  total('(=) RECEITA LÍQUIDA', liquida);
  total('(-) CUSTO DOS PRODUTOS E SERVIÇOS (CMV)', cmv.neg()); detalhes('CMV', -1);
  total('(=) LUCRO BRUTO', lucroBruto, lucroBruto.lt(0));
  total('(-) DESPESAS VARIÁVEIS', variaveis.neg()); detalhes('DESPESA_VARIAVEL', -1);
  total('(-) DESPESAS FIXAS', fixas.neg()); detalhes('DESPESA_FIXA', -1);
  total('(=) LUCRO LÍQUIDO', lucro, lucro.lt(0));

  r.resumo = [
    { rotulo: 'Receita bruta', valor: receitaBruta.toFixed(2), tipo: 'moeda' },
    { rotulo: 'Lucro bruto', valor: lucroBruto.toFixed(2), tipo: 'moeda' },
    { rotulo: 'Margem bruta', valor: pctDe(lucroBruto, receitaBruta), tipo: 'pct' },
    { rotulo: 'Lucro líquido', valor: lucro.toFixed(2), tipo: 'moeda', alerta: lucro.lt(0) },
    { rotulo: 'Margem líquida', valor: pctDe(lucro, receitaBruta), tipo: 'pct', alerta: lucro.lt(0) },
  ];
  r.tabelas.push({
    colunas: [{ chave: 'conta', titulo: 'Conta', tipo: 'texto', peso: 4 }, { chave: 'valor', titulo: 'Valor', tipo: 'moeda' }, { chave: 'pct', titulo: '% da receita', tipo: 'pct' }],
    linhas: out,
  });
  r.observacoes.push(caixa
    ? 'Regime de caixa: só o que foi efetivamente recebido e pago no período (pela data do pagamento).'
    : 'Regime de competência: vendas pela data da venda, com o custo do mesmo pedido (pago ou não). Contas a pagar avulsas pela data informada.');
  if (estimado.gt(0)) r.observacoes.push(`Inclui R$ ${estimado.toFixed(2).replace('.', ',')} de custo previsto (orçamento) de pedidos que ainda não têm as compras ou o instalador lançados.`);
  r.observacoes.push('MEI: o imposto é o DAS mensal, que aparece nas despesas fixas (5.04).');
  return r;
}

const nomeConta = (n: string) => n
  .replace('Servicos', 'Serviços').replace('Instalacao', 'Instalação').replace('Manutencao', 'Manutenção').replace('Motorizacao', 'Motorização')
  .replace('Cartao', 'Cartão').replace('Antecip.', 'Antecipação').replace('Mao de Obra', 'Mão de Obra').replace('Atelie', 'Ateliê')
  .replace('Terceirizacao', 'Terceirização').replace('Comissoes', 'Comissões').replace('Combustivel', 'Combustível')
  .replace('Condominio', 'Condomínio').replace('Salarios', 'Salários').replace('Pro-labore', 'Pró-labore').replace('Anuncios', 'Anúncios')
  .replace('Devolucoes', 'Devoluções').replace('Variaveis', 'Variáveis').replace('Persianas e Acabamentos', 'Persianas e Acabamentos');

// ------------------------------------------------------------------ 2. Faturamento

async function faturamento(db: Banco, lojaId: string, f: Filtros): Promise<Relatorio> {
  const r = base('faturamento', f);
  const dias = (Date.parse(f.ate) - Date.parse(f.de)) / 86_400_000;
  const agrupar = f.agrupar ?? (dias <= 31 ? 'dia' : dias <= 400 ? 'mes' : 'ano');
  const trunc = sql.raw(`'${agrupar === 'dia' ? 'day' : agrupar === 'mes' ? 'month' : 'year'}'`);
  const rows = await linhas<{ b: string; n: number; total: string }>(db, sql`
    SELECT to_char(date_trunc(${trunc}, ${dataVenda}), 'YYYY-MM-DD') AS b, COUNT(*)::int AS n, SUM(p.valor_total_final)::text AS total
      FROM pedidos p WHERE p.loja_id = ${lojaId} AND p.status_operacional <> 'CANCELADO' AND ${dataVenda} BETWEEN ${f.de}::date AND ${f.ate}::date
     GROUP BY 1 ORDER BY 1`);
  const rotulo = (b: string) => (agrupar === 'dia' ? b : agrupar === 'mes' ? `${b.slice(5, 7)}/${b.slice(0, 4)}` : b.slice(0, 4));
  const totalN = rows.reduce((s, x) => s + x.n, 0);
  const totalV = soma(rows.map((x) => d(x.total)));
  r.tabelas.push({
    titulo: `Vendas por ${agrupar === 'dia' ? 'dia' : agrupar === 'mes' ? 'mês' : 'ano'}`,
    colunas: [
      { chave: 'periodo', titulo: agrupar === 'dia' ? 'Dia' : agrupar === 'mes' ? 'Mês' : 'Ano', tipo: agrupar === 'dia' ? 'data' : 'texto' },
      { chave: 'pedidos', titulo: 'Pedidos', tipo: 'int' }, { chave: 'valor', titulo: 'Vendido', tipo: 'moeda' },
      { chave: 'ticket', titulo: 'Ticket médio', tipo: 'moeda' }, { chave: 'pct', titulo: '% do período', tipo: 'pct' },
    ],
    linhas: rows.map((x) => ({ periodo: rotulo(x.b), pedidos: x.n, valor: d(x.total).toFixed(2), ticket: dinheiro(d(x.total).div(x.n)).toFixed(2), pct: pctDe(d(x.total), totalV) })),
    total: { periodo: 'Total', pedidos: totalN, valor: totalV.toFixed(2), ticket: totalN ? dinheiro(totalV.div(totalN)).toFixed(2) : '0.00', pct: totalN ? '100.00' : '0.00', _nivel: 0 },
    vazio: 'Nenhuma venda no período.',
  });
  const formas = await linhas<{ forma: string | null; n: number; total: string }>(db, sql`
    SELECT l.forma_pagamento AS forma, COUNT(DISTINCT l.pedido_id)::int AS n, SUM(l.valor_bruto)::text AS total
      FROM lancamentos_financeiros l JOIN pedidos p ON p.id = l.pedido_id
     WHERE p.loja_id = ${lojaId} AND p.status_operacional <> 'CANCELADO' AND ${dataVenda} BETWEEN ${f.de}::date AND ${f.ate}::date
       AND l.tipo = 'RECEITA' AND l.status <> 'CANCELADO'
     GROUP BY 1 ORDER BY SUM(l.valor_bruto) DESC`);
  const totF = soma(formas.map((x) => d(x.total)));
  r.tabelas.push({
    titulo: 'Por forma de pagamento',
    colunas: [{ chave: 'forma', titulo: 'Forma', tipo: 'texto' }, { chave: 'pedidos', titulo: 'Pedidos', tipo: 'int' },
      { chave: 'valor', titulo: 'Valor', tipo: 'moeda' }, { chave: 'pct', titulo: '%', tipo: 'pct' }],
    linhas: formas.map((x) => ({ forma: x.forma ? NOME_FORMA[x.forma] ?? x.forma : 'A definir', pedidos: x.n, valor: d(x.total).toFixed(2), pct: pctDe(d(x.total), totF) })),
    vazio: 'Sem cobranças no período.',
  });
  r.resumo = [
    { rotulo: 'Vendido', valor: totalV.toFixed(2), tipo: 'moeda' },
    { rotulo: 'Pedidos', valor: String(totalN), tipo: 'int' },
    { rotulo: 'Ticket médio', valor: totalN ? dinheiro(totalV.div(totalN)).toFixed(2) : '0.00', tipo: 'moeda' },
  ];
  r.observacoes.push('Vendas = pedidos fechados (orçamento aprovado) pela data da venda, sem os cancelados. "A definir" = cobrança ainda sem forma combinada.');
  return r;
}

// ------------------------------------------------------------------ 3. Rentabilidade real por pedido

async function rentabilidade(db: Banco, lojaId: string, f: Filtros): Promise<Relatorio> {
  const r = base('rentabilidade', f);
  const ids = await linhas<{ id: string }>(db, sql`
    SELECT p.id FROM pedidos p WHERE p.loja_id = ${lojaId} AND p.status_operacional <> 'CANCELADO'
       AND ${dataVenda} BETWEEN ${f.de}::date AND ${f.ate}::date ORDER BY p.data_compra LIMIT 1000`);
  const lp = await lucroPedidos(db, ids.map((x) => x.id), lojaId);
  const t = (k: 'venda' | 'custoPrevisto' | 'custoReal' | 'taxas' | 'comissao' | 'lucro') => soma(lp.map((x) => d(x[k])));
  r.tabelas.push({
    colunas: [
      { chave: 'pedido', titulo: 'Pedido', tipo: 'texto' }, { chave: 'cliente', titulo: 'Cliente', tipo: 'texto', peso: 2 },
      { chave: 'venda', titulo: 'Vendido', tipo: 'moeda' }, { chave: 'custoPrevisto', titulo: 'Custo previsto', tipo: 'moeda' },
      { chave: 'custoReal', titulo: 'Custo real', tipo: 'moeda' }, { chave: 'taxasComissao', titulo: 'Taxas e comissão', tipo: 'moeda' },
      { chave: 'lucro', titulo: 'Lucro', tipo: 'moeda' }, { chave: 'margem', titulo: 'Margem', tipo: 'pct' },
      { chave: 'alerta', titulo: 'Alerta', tipo: 'texto', peso: 2 },
    ],
    linhas: lp.map((x) => ({
      pedido: x.numero, cliente: x.cliente, venda: x.venda, custoPrevisto: x.custoPrevisto,
      custoReal: x.custoReal, taxasComissao: d(x.taxas).plus(d(x.comissao)).plus(d(x.imposto)).toFixed(2), lucro: x.lucro, margem: x.margemPct,
      alerta: [...x.alertas, x.custoEstimado ? 'custo real parcial (compras ou instalação ainda não lançadas)' : ''].filter(Boolean).join('; '),
      _alerta: x.alertas.length > 0,
    })),
    total: {
      pedido: 'Total', cliente: `${lp.length} pedido(s)`, venda: t('venda').toFixed(2), custoPrevisto: t('custoPrevisto').toFixed(2),
      custoReal: t('custoReal').toFixed(2), taxasComissao: t('taxas').plus(t('comissao')).plus(soma(lp.map((x) => d(x.imposto)))).toFixed(2),
      lucro: t('lucro').toFixed(2), margem: pctDe(t('lucro'), t('venda')), alerta: '', _nivel: 0,
    },
    vazio: 'Nenhum pedido no período.',
  });
  const alertas = lp.filter((x) => x.alertas.length).length;
  r.resumo = [
    { rotulo: 'Vendido', valor: t('venda').toFixed(2), tipo: 'moeda' },
    { rotulo: 'Lucro real', valor: t('lucro').toFixed(2), tipo: 'moeda', alerta: t('lucro').lt(0) },
    { rotulo: 'Margem real', valor: pctDe(t('lucro'), t('venda')), tipo: 'pct' },
    { rotulo: 'Custo real x previsto', valor: t('custoReal').minus(t('custoPrevisto')).toFixed(2), tipo: 'moeda', alerta: t('custoReal').gt(t('custoPrevisto')) },
    { rotulo: 'Pedidos com alerta', valor: String(alertas), tipo: 'int', alerta: alertas > 0 },
  ];
  r.observacoes.push('Lucro = vendido - custo real (compras, costura, fábrica, instalador e outros custos lançados no pedido) - taxas de cartão/boleto - comissão. MEI: sem imposto por venda.');
  r.observacoes.push('Enquanto as compras ou a instalação não foram lançadas, entra o custo previsto do orçamento no lugar.');
  return r;
}

// ------------------------------------------------------------------ 4. Fluxo de caixa

async function fluxoCaixa(db: Banco, lojaId: string, f: Filtros): Promise<Relatorio> {
  const r = base('fluxo-caixa', f);
  const hoje = hojeLoja();
  const val = sql`CASE WHEN l.tipo = 'RECEITA' THEN l.valor_liquido ELSE -l.valor_liquido END`;
  const [ini] = await linhas<{ inicial: string; atual: string }>(db, sql`
    SELECT (COALESCE((SELECT SUM(saldo_inicial) FROM contas_financeiras WHERE loja_id = ${lojaId}), 0)
            + COALESCE((SELECT SUM(${val}) FROM lancamentos_financeiros l WHERE l.loja_id = ${lojaId} AND l.status = 'LIQUIDADO'
                         AND l.data_liquidacao < ${f.de}::date), 0))::text AS inicial,
           (COALESCE((SELECT SUM(saldo_inicial) FROM contas_financeiras WHERE loja_id = ${lojaId}), 0)
            + COALESCE((SELECT SUM(${val}) FROM lancamentos_financeiros l WHERE l.loja_id = ${lojaId} AND l.status = 'LIQUIDADO'
                         AND l.data_liquidacao <= ${hoje}::date), 0))::text AS atual`);
  const dias = (Date.parse(f.ate) - Date.parse(f.de)) / 86_400_000;
  const porDia = dias <= 62;
  const trunc = sql.raw(porDia ? `'day'` : `'month'`);
  const movs = await linhas<{ b: string; er: string; sr: string; ep: string; sp: string }>(db, sql`
    SELECT to_char(date_trunc(${trunc}, COALESCE(l.data_liquidacao, l.data_vencimento)), 'YYYY-MM-DD') AS b,
           COALESCE(SUM(l.valor_liquido) FILTER (WHERE l.status = 'LIQUIDADO' AND l.tipo = 'RECEITA'), 0)::text AS er,
           COALESCE(SUM(l.valor_liquido) FILTER (WHERE l.status = 'LIQUIDADO' AND l.tipo = 'DESPESA'), 0)::text AS sr,
           COALESCE(SUM(l.valor_liquido) FILTER (WHERE l.status = 'PREVISTO' AND l.tipo = 'RECEITA'), 0)::text AS ep,
           COALESCE(SUM(l.valor_liquido) FILTER (WHERE l.status = 'PREVISTO' AND l.tipo = 'DESPESA'), 0)::text AS sp
      FROM lancamentos_financeiros l
     WHERE l.loja_id = ${lojaId} AND l.status IN ('LIQUIDADO', 'PREVISTO')
       AND ((l.status = 'LIQUIDADO' AND l.data_liquidacao BETWEEN ${f.de}::date AND ${f.ate}::date)
         OR (l.status = 'PREVISTO' AND l.data_vencimento BETWEEN ${f.de}::date AND ${f.ate}::date))
     GROUP BY 1 ORDER BY 1`);
  let acumulado = d(ini!.inicial);
  const tot = { er: Z(), sr: Z(), ep: Z(), sp: Z() };
  const out: Linha[] = movs.map((m) => {
    const x = { er: d(m.er), sr: d(m.sr), ep: d(m.ep), sp: d(m.sp) };
    (Object.keys(tot) as (keyof typeof tot)[]).forEach((k) => { tot[k] = tot[k].plus(x[k]); });
    const doDia = x.er.minus(x.sr).plus(x.ep).minus(x.sp);
    acumulado = acumulado.plus(doDia);
    return {
      periodo: porDia ? m.b : `${m.b.slice(5, 7)}/${m.b.slice(0, 4)}`, entradasRealizadas: x.er.toFixed(2), saidasRealizadas: x.sr.toFixed(2),
      entradasPrevistas: x.ep.toFixed(2), saidasPrevistas: x.sp.toFixed(2), saldo: doDia.toFixed(2), acumulado: acumulado.toFixed(2),
      _alerta: acumulado.lt(0),
    };
  });
  r.tabelas.push({
    titulo: `Movimento por ${porDia ? 'dia' : 'mês'} (saldo inicial R$ ${d(ini!.inicial).toFixed(2).replace('.', ',')})`,
    colunas: [
      { chave: 'periodo', titulo: porDia ? 'Dia' : 'Mês', tipo: porDia ? 'data' : 'texto' },
      { chave: 'entradasRealizadas', titulo: 'Entrou', tipo: 'moeda' }, { chave: 'saidasRealizadas', titulo: 'Saiu', tipo: 'moeda' },
      { chave: 'entradasPrevistas', titulo: 'A entrar', tipo: 'moeda' }, { chave: 'saidasPrevistas', titulo: 'A sair', tipo: 'moeda' },
      { chave: 'saldo', titulo: 'Resultado', tipo: 'moeda' }, { chave: 'acumulado', titulo: 'Saldo acumulado', tipo: 'moeda' },
    ],
    linhas: out,
    total: {
      periodo: 'Total', entradasRealizadas: tot.er.toFixed(2), saidasRealizadas: tot.sr.toFixed(2), entradasPrevistas: tot.ep.toFixed(2),
      saidasPrevistas: tot.sp.toFixed(2), saldo: tot.er.minus(tot.sr).plus(tot.ep).minus(tot.sp).toFixed(2), acumulado: acumulado.toFixed(2), _nivel: 0,
    },
    vazio: 'Sem movimento no período.',
  });
  const projecoes: Linha[] = [];
  for (const n of [30, 60, 90]) {
    const lim = somarDias(hoje, n);
    const [p] = await linhas<{ e: string; s: string }>(db, sql`
      SELECT COALESCE(SUM(valor_liquido) FILTER (WHERE tipo = 'RECEITA'), 0)::text AS e,
             COALESCE(SUM(valor_liquido) FILTER (WHERE tipo = 'DESPESA'), 0)::text AS s
        FROM lancamentos_financeiros WHERE loja_id = ${lojaId} AND status = 'PREVISTO' AND data_vencimento <= ${lim}::date`);
    const saldo = d(ini!.atual).plus(d(p!.e)).minus(d(p!.s));
    projecoes.push({ prazo: `Até ${br(lim)} (${n} dias)`, entradas: d(p!.e).toFixed(2), saidas: d(p!.s).toFixed(2), saldo: saldo.toFixed(2), _alerta: saldo.lt(0) });
  }
  r.tabelas.push({
    titulo: `Saldo projetado (saldo de hoje R$ ${d(ini!.atual).toFixed(2).replace('.', ',')})`,
    colunas: [{ chave: 'prazo', titulo: 'Prazo', tipo: 'texto', peso: 2 }, { chave: 'entradas', titulo: 'A entrar', tipo: 'moeda' },
      { chave: 'saidas', titulo: 'A sair', tipo: 'moeda' }, { chave: 'saldo', titulo: 'Saldo projetado', tipo: 'moeda' }],
    linhas: projecoes,
  });
  r.resumo = [
    { rotulo: 'Saldo inicial', valor: d(ini!.inicial).toFixed(2), tipo: 'moeda' },
    { rotulo: 'Saldo de hoje', valor: d(ini!.atual).toFixed(2), tipo: 'moeda', alerta: d(ini!.atual).lt(0) },
    { rotulo: 'Saldo final previsto', valor: acumulado.toFixed(2), tipo: 'moeda', alerta: acumulado.lt(0) },
    ...projecoes.map((p, i) => ({ rotulo: `Projeção ${[30, 60, 90][i]} dias`, valor: String(p.saldo), tipo: 'moeda' as const, alerta: Boolean(p._alerta) })),
  ];
  r.observacoes.push('Entradas já descontam a taxa do cartão/boleto. Previstos vencidos (atrasados) entram nas projeções.');
  r.observacoes.push('Saldo inicial = saldo inicial das contas (Financeiro > Configurar) + tudo o que entrou e saiu antes do período.');
  return r;
}

// ------------------------------------------------------------------ 5. Contas a pagar e a receber (aging)

async function contas(db: Banco, lojaId: string, _f: Filtros): Promise<Relatorio> {
  const hoje = hojeLoja();
  const r = base('contas', _f, `Posição de ${br(hoje)}`);
  const faixa = sql`CASE WHEN l.data_vencimento < ${hoje}::date THEN 0 WHEN l.data_vencimento = ${hoje}::date THEN 1
    WHEN l.data_vencimento <= ${hoje}::date + 7 THEN 2 WHEN l.data_vencimento <= ${hoje}::date + 30 THEN 3 ELSE 4 END`;
  const aberto = sql`l.loja_id = ${lojaId} AND l.status = 'PREVISTO' AND NOT l.cartao`;
  const resumo = await linhas<{ tipo: string; faixa: number; n: number; v: string }>(db, sql`
    SELECT l.tipo, ${faixa} AS faixa, COUNT(*)::int AS n, SUM(l.valor_bruto)::text AS v
      FROM lancamentos_financeiros l WHERE ${aberto} GROUP BY 1, 2`);
  const nomes = ['Vencidos', 'Vencem hoje', 'Próximos 7 dias', 'De 8 a 30 dias', 'Depois de 30 dias'];
  const pega = (t: string, i: number) => resumo.find((x) => x.tipo === t && x.faixa === i);
  r.tabelas.push({
    titulo: 'Resumo por vencimento',
    colunas: [{ chave: 'faixa', titulo: 'Vencimento', tipo: 'texto', peso: 2 }, { chave: 'nr', titulo: 'A receber (qtd)', tipo: 'int' },
      { chave: 'vr', titulo: 'A receber', tipo: 'moeda' }, { chave: 'np', titulo: 'A pagar (qtd)', tipo: 'int' }, { chave: 'vp', titulo: 'A pagar', tipo: 'moeda' }],
    linhas: nomes.map((n, i) => ({
      faixa: n, nr: pega('RECEITA', i)?.n ?? 0, vr: d(pega('RECEITA', i)?.v ?? 0).toFixed(2),
      np: pega('DESPESA', i)?.n ?? 0, vp: d(pega('DESPESA', i)?.v ?? 0).toFixed(2), _alerta: i === 0 && Boolean(pega('RECEITA', 0) || pega('DESPESA', 0)),
    })),
    total: {
      faixa: 'Total em aberto', nr: resumo.filter((x) => x.tipo === 'RECEITA').reduce((s, x) => s + x.n, 0),
      vr: soma(resumo.filter((x) => x.tipo === 'RECEITA').map((x) => d(x.v))).toFixed(2),
      np: resumo.filter((x) => x.tipo === 'DESPESA').reduce((s, x) => s + x.n, 0),
      vp: soma(resumo.filter((x) => x.tipo === 'DESPESA').map((x) => d(x.v))).toFixed(2), _nivel: 0,
    },
  });
  const lista = (tipo: 'RECEITA' | 'DESPESA') => linhas<{ quem: string | null; pedido: string | null; descricao: string; venc: string; atraso: number; valor: string }>(db, sql`
    SELECT ${tipo === 'RECEITA' ? sql`c.nome_completo` : sql`COALESCE(f.nome_fantasia, us.nome)`} AS quem, p.numero_pedido AS pedido, l.descricao,
           to_char(l.data_vencimento, 'YYYY-MM-DD') AS venc, GREATEST(${hoje}::date - l.data_vencimento, 0)::int AS atraso, l.valor_bruto::text AS valor
      FROM lancamentos_financeiros l LEFT JOIN pedidos p ON p.id = l.pedido_id
      LEFT JOIN clientes c ON c.id = COALESCE(l.cliente_id, p.cliente_id) LEFT JOIN fornecedores f ON f.id = l.fornecedor_id
      LEFT JOIN usuarios us ON us.id = l.vendedor_id
     WHERE ${aberto} AND l.tipo = ${tipo} AND l.data_vencimento <= ${hoje}::date + 30
     ORDER BY l.data_vencimento, l.criado_em LIMIT 500`);
  const colunasLista = (quem: string) => [
    { chave: 'quem', titulo: quem, tipo: 'texto' as const, peso: 2 }, { chave: 'pedido', titulo: 'Pedido', tipo: 'texto' as const },
    { chave: 'descricao', titulo: 'Descrição', tipo: 'texto' as const, peso: 3 }, { chave: 'venc', titulo: 'Vencimento', tipo: 'data' as const },
    { chave: 'atraso', titulo: 'Dias de atraso', tipo: 'int' as const }, { chave: 'valor', titulo: 'Valor', tipo: 'moeda' as const },
  ];
  const mapa = (x: Awaited<ReturnType<typeof lista>>[number]) => ({ ...x, quem: x.quem ?? '-', pedido: x.pedido ?? '-', valor: d(x.valor).toFixed(2), _alerta: x.atraso > 0 });
  r.tabelas.push({ titulo: 'A receber: vencidos e próximos 30 dias', colunas: colunasLista('Cliente'), linhas: (await lista('RECEITA')).map(mapa), vazio: 'Nada a receber nos próximos 30 dias.' });
  r.tabelas.push({ titulo: 'A pagar: vencidos e próximos 30 dias', colunas: colunasLista('Fornecedor'), linhas: (await lista('DESPESA')).map(mapa), vazio: 'Nada a pagar nos próximos 30 dias.' });
  const inst = await linhas<{ pedido: string; cliente: string; telefone: string; instalado: string; saldo: string; venc: string }>(db, sql`
    SELECT p.numero_pedido AS pedido, c.nome_completo AS cliente, c.telefone_whatsapp AS telefone,
           to_char((p.data_instalacao_realizada AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS instalado,
           SUM(l.valor_bruto)::text AS saldo, to_char(MIN(l.data_vencimento), 'YYYY-MM-DD') AS venc
      FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
      JOIN lancamentos_financeiros l ON l.pedido_id = p.id AND l.tipo = 'RECEITA' AND l.status = 'PREVISTO' AND NOT l.cartao
     WHERE p.loja_id = ${lojaId} AND p.status_operacional = 'INSTALADO_CONCLUIDO'
     GROUP BY p.id, c.id ORDER BY MIN(l.data_vencimento)`);
  r.tabelas.push({
    titulo: 'Pedidos já instalados com saldo em aberto',
    colunas: [{ chave: 'pedido', titulo: 'Pedido', tipo: 'texto' }, { chave: 'cliente', titulo: 'Cliente', tipo: 'texto', peso: 2 },
      { chave: 'telefone', titulo: 'Telefone', tipo: 'texto' }, { chave: 'instalado', titulo: 'Instalado em', tipo: 'data' },
      { chave: 'venc', titulo: 'Vencia em', tipo: 'data' }, { chave: 'saldo', titulo: 'Saldo', tipo: 'moeda' }],
    linhas: inst.map((x) => ({ ...x, saldo: d(x.saldo).toFixed(2), _alerta: true })),
    vazio: 'Nenhum pedido instalado com saldo em aberto.',
  });
  const [maq] = await linhas<{ v: string }>(db, sql`
    SELECT COALESCE(SUM(valor_liquido), 0)::text AS v FROM lancamentos_financeiros WHERE loja_id = ${lojaId} AND status = 'PREVISTO' AND cartao`);
  const vencR = d(pega('RECEITA', 0)?.v ?? 0);
  const vencP = d(pega('DESPESA', 0)?.v ?? 0);
  r.resumo = [
    { rotulo: 'A receber vencido (inadimplência)', valor: vencR.toFixed(2), tipo: 'moeda', alerta: vencR.gt(0) },
    { rotulo: 'A pagar vencido', valor: vencP.toFixed(2), tipo: 'moeda', alerta: vencP.gt(0) },
    { rotulo: 'Instalados com saldo', valor: soma(inst.map((x) => d(x.saldo))).toFixed(2), tipo: 'moeda', alerta: inst.length > 0 },
    { rotulo: 'A cair da maquininha', valor: d(maq!.v).toFixed(2), tipo: 'moeda' },
  ];
  r.observacoes.push('A receber = o que os clientes ainda devem. Os repasses da maquininha (cliente já pagou no cartão) aparecem só no total "A cair da maquininha".');
  return r;
}

// ------------------------------------------------------------------ 6. Funil de vendas

async function funil(db: Banco, lojaId: string, f: Filtros): Promise<Relatorio> {
  const r = base('funil', f);
  const proj = await linhas<{ vendedor: string; origem: string; status: string; motivo: string | null; valor: string; aprovado: boolean; valorAprovado: string | null }>(db, sql`
    WITH g AS (
      SELECT grupo_id FROM orcamentos WHERE loja_id = ${lojaId} AND aditivo_pedido_id IS NULL
       GROUP BY grupo_id
      HAVING (MIN(data_criacao) AT TIME ZONE ${FUSO})::date BETWEEN ${f.de}::date AND ${f.ate}::date
         AND (bool_or(status <> 'RASCUNHO') OR bool_or(enviado_em IS NOT NULL))),
    ult AS (
      SELECT DISTINCT ON (o.grupo_id) o.grupo_id, o.status, o.motivo_perda, o.valor_total_venda, o.vendedor_id, o.cliente_id
        FROM orcamentos o JOIN g ON g.grupo_id = o.grupo_id WHERE o.aditivo_pedido_id IS NULL
       ORDER BY o.grupo_id, o.versao DESC)
    SELECT u.nome AS vendedor, COALESCE(NULLIF(TRIM(c.origem_lead), ''), 'Não informada') AS origem, ult.status, ult.motivo_perda AS motivo,
           COALESCE(p.valor_original, ult.valor_total_venda)::text AS valor, (p.id IS NOT NULL AND p.status_operacional <> 'CANCELADO') AS aprovado,
           p.valor_original::text AS "valorAprovado"
      FROM ult JOIN usuarios u ON u.id = ult.vendedor_id JOIN clientes c ON c.id = ult.cliente_id
      LEFT JOIN pedidos p ON p.grupo_orcamento_id = ult.grupo_id`);
  const agrupar = (chave: 'vendedor' | 'origem') => {
    const m = new Map<string, { n: number; v: Decimal; na: number; va: Decimal }>();
    for (const x of proj) {
      const k = x[chave];
      const a = m.get(k) ?? { n: 0, v: Z(), na: 0, va: Z() };
      a.n++; a.v = a.v.plus(d(x.valor));
      if (x.aprovado) { a.na++; a.va = a.va.plus(d(x.valorAprovado ?? x.valor)); }
      m.set(k, a);
    }
    return [...m.entries()].sort((a, b) => b[1].v.cmp(a[1].v)).map(([k, a]) => ({
      nome: k, orcados: a.n, valorOrcado: a.v.toFixed(2), aprovados: a.na, valorAprovado: a.va.toFixed(2),
      conversao: pctDe(d(a.na), d(a.n)), conversaoValor: pctDe(a.va, a.v),
    }));
  };
  const colunas = (nome: string) => [
    { chave: 'nome', titulo: nome, tipo: 'texto' as const, peso: 2 }, { chave: 'orcados', titulo: 'Orçamentos', tipo: 'int' as const },
    { chave: 'valorOrcado', titulo: 'Orçado', tipo: 'moeda' as const }, { chave: 'aprovados', titulo: 'Aprovados', tipo: 'int' as const },
    { chave: 'valorAprovado', titulo: 'Aprovado', tipo: 'moeda' as const }, { chave: 'conversao', titulo: 'Conversão (qtd)', tipo: 'pct' as const },
    { chave: 'conversaoValor', titulo: 'Conversão (R$)', tipo: 'pct' as const },
  ];
  const tot = agrupar('vendedor').reduce((s, x) => ({
    n: s.n + x.orcados, v: s.v.plus(d(x.valorOrcado)), na: s.na + x.aprovados, va: s.va.plus(d(x.valorAprovado)),
  }), { n: 0, v: Z(), na: 0, va: Z() });
  const totalLinha = {
    nome: 'Total', orcados: tot.n, valorOrcado: tot.v.toFixed(2), aprovados: tot.na, valorAprovado: tot.va.toFixed(2),
    conversao: pctDe(d(tot.na), d(tot.n)), conversaoValor: pctDe(tot.va, tot.v), _nivel: 0,
  };
  r.tabelas.push({ titulo: 'Por vendedor', colunas: colunas('Vendedor'), linhas: agrupar('vendedor'), total: totalLinha, vazio: 'Nenhum orçamento enviado no período.' });
  r.tabelas.push({ titulo: 'Por origem do cliente', colunas: colunas('Origem'), linhas: agrupar('origem'), total: totalLinha, vazio: 'Nenhum orçamento enviado no período.' });
  const perdas = new Map<string, { n: number; v: Decimal }>();
  for (const x of proj.filter((p) => p.status === 'PERDIDO' || p.status === 'EXPIRADO')) {
    const k = x.status === 'EXPIRADO' ? 'Venceu a validade' : x.motivo?.trim() || 'Sem motivo informado';
    const a = perdas.get(k) ?? { n: 0, v: Z() };
    perdas.set(k, { n: a.n + 1, v: a.v.plus(d(x.valor)) });
  }
  const nPerdas = [...perdas.values()].reduce((s, x) => s + x.n, 0);
  r.tabelas.push({
    titulo: 'Motivos de perda',
    colunas: [{ chave: 'motivo', titulo: 'Motivo', tipo: 'texto', peso: 3 }, { chave: 'n', titulo: 'Orçamentos', tipo: 'int' },
      { chave: 'pct', titulo: '% das perdas', tipo: 'pct' }, { chave: 'v', titulo: 'Valor perdido', tipo: 'moeda' }],
    linhas: [...perdas.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, a]) => ({ motivo: k, n: a.n, pct: pctDe(d(a.n), d(nPerdas)), v: a.v.toFixed(2) })),
    vazio: 'Nenhuma perda registrada no período.',
  });
  const emAberto = proj.filter((p) => !p.aprovado && !['PERDIDO', 'EXPIRADO'].includes(p.status)).length;
  r.resumo = [
    { rotulo: 'Total orçado', valor: tot.v.toFixed(2), tipo: 'moeda' },
    { rotulo: 'Total aprovado', valor: tot.va.toFixed(2), tipo: 'moeda' },
    { rotulo: 'Conversão (qtd)', valor: pctDe(d(tot.na), d(tot.n)), tipo: 'pct' },
    { rotulo: 'Conversão (R$)', valor: pctDe(tot.va, tot.v), tipo: 'pct' },
    { rotulo: 'Em negociação', valor: String(emAberto), tipo: 'int' },
    { rotulo: 'Perdidos', valor: String(nPerdas), tipo: 'int' },
  ];
  r.observacoes.push('Conta cada projeto uma vez (todas as versões juntas), pela data do primeiro orçamento. Rascunhos nunca enviados ficam de fora.');
  return r;
}

// ------------------------------------------------------------------ 7. Curva ABC

async function curvaAbc(db: Banco, lojaId: string, f: Filtros): Promise<Relatorio> {
  const r = base('curva-abc', f);
  const precoLiq = sql`CASE WHEN oc.preco_total_liquido > 0 OR oc.desconto_rateado > 0 THEN oc.preco_total_liquido ELSE oc.preco_total END`;
  const prods = await linhas<{ sku: string; nome: string; categoria: string; un: string; qtd: string; fat: string; custo: string }>(db, sql`
    SELECT oc.sku_snapshot AS sku, MAX(oc.descricao_snapshot) AS nome, COALESCE(MAX(cat.nome), 'Sem categoria') AS categoria,
           MAX(oc.unidade_medida_snapshot::text) AS un, SUM(oc.quantidade_final)::text AS qtd,
           SUM(${precoLiq})::text AS fat, SUM(oc.custo_total)::text AS custo
      FROM pedidos p JOIN orcamento_itens_compostos i ON i.orcamento_id = p.orcamento_id
      JOIN orcamento_componentes oc ON oc.item_composto_id = i.id
      LEFT JOIN produtos pr ON pr.id = oc.produto_id LEFT JOIN categorias_produto cat ON cat.id = pr.categoria_id
     WHERE p.loja_id = ${lojaId} AND p.status_operacional <> 'CANCELADO' AND ${dataVenda} BETWEEN ${f.de}::date AND ${f.ate}::date
     GROUP BY oc.sku_snapshot ORDER BY SUM(${precoLiq}) DESC`);
  const total = soma(prods.map((p) => d(p.fat)));
  let acum = Z();
  const linhasAbc = prods.map((p) => {
    const fat = d(p.fat);
    acum = acum.plus(fat);
    const acumPct = total.gt(0) ? acum.div(total).mul(100) : Z();
    const anteriorPct = total.gt(0) ? acum.minus(fat).div(total).mul(100) : Z();
    const classe = anteriorPct.lt(80) ? 'A' : anteriorPct.lt(95) ? 'B' : 'C';
    const lucro = fat.minus(d(p.custo));
    return {
      classe, sku: p.sku, nome: p.nome, categoria: p.categoria, qtd: `${d(p.qtd).toFixed(p.un === 'UN' || p.un === 'PC' ? 0 : 2).replace('.', ',')} ${p.un}`,
      fat: fat.toFixed(2), pct: pctDe(fat, total), acum: acumPct.toFixed(2), lucro: lucro.toFixed(2), margem: pctDe(lucro, fat), _alerta: lucro.lt(0),
    };
  });
  const totCusto = soma(prods.map((p) => d(p.custo)));
  r.tabelas.push({
    titulo: 'Produtos (curva ABC pelo faturamento)',
    colunas: [
      { chave: 'classe', titulo: 'Classe', tipo: 'texto' }, { chave: 'sku', titulo: 'SKU', tipo: 'texto' }, { chave: 'nome', titulo: 'Produto', tipo: 'texto', peso: 3 },
      { chave: 'categoria', titulo: 'Categoria', tipo: 'texto', peso: 2 }, { chave: 'qtd', titulo: 'Quantidade', tipo: 'texto' },
      { chave: 'fat', titulo: 'Faturamento', tipo: 'moeda' }, { chave: 'pct', titulo: '%', tipo: 'pct' }, { chave: 'acum', titulo: '% acumulado', tipo: 'pct' },
      { chave: 'lucro', titulo: 'Lucro bruto', tipo: 'moeda' }, { chave: 'margem', titulo: 'Margem', tipo: 'pct' },
    ],
    linhas: linhasAbc,
    total: { classe: '', sku: '', nome: 'Total', categoria: '', qtd: '', fat: total.toFixed(2), pct: total.gt(0) ? '100.00' : '0.00', acum: '', lucro: total.minus(totCusto).toFixed(2), margem: pctDe(total.minus(totCusto), total), _nivel: 0 },
    vazio: 'Nenhuma venda no período.',
  });
  const cats = new Map<string, { fat: Decimal; custo: Decimal }>();
  for (const p of prods) {
    const a = cats.get(p.categoria) ?? { fat: Z(), custo: Z() };
    cats.set(p.categoria, { fat: a.fat.plus(d(p.fat)), custo: a.custo.plus(d(p.custo)) });
  }
  r.tabelas.push({
    titulo: 'Categorias',
    colunas: [{ chave: 'categoria', titulo: 'Categoria', tipo: 'texto', peso: 2 }, { chave: 'fat', titulo: 'Faturamento', tipo: 'moeda' },
      { chave: 'pct', titulo: '%', tipo: 'pct' }, { chave: 'lucro', titulo: 'Lucro bruto', tipo: 'moeda' }, { chave: 'margem', titulo: 'Margem', tipo: 'pct' }],
    linhas: [...cats.entries()].sort((a, b) => b[1].fat.cmp(a[1].fat)).map(([k, a]) => ({
      categoria: k, fat: a.fat.toFixed(2), pct: pctDe(a.fat, total), lucro: a.fat.minus(a.custo).toFixed(2), margem: pctDe(a.fat.minus(a.custo), a.fat),
    })),
    vazio: 'Nenhuma venda no período.',
  });
  r.tabelas.push({
    titulo: 'Top 10 em lucro (R$)',
    colunas: [{ chave: 'sku', titulo: 'SKU', tipo: 'texto' }, { chave: 'nome', titulo: 'Produto', tipo: 'texto', peso: 3 },
      { chave: 'lucro', titulo: 'Lucro bruto', tipo: 'moeda' }, { chave: 'margem', titulo: 'Margem', tipo: 'pct' }],
    linhas: [...linhasAbc].sort((a, b) => d(b.lucro).cmp(d(a.lucro))).slice(0, 10).map(({ sku, nome, lucro, margem }) => ({ sku, nome, lucro, margem })),
    vazio: 'Nenhuma venda no período.',
  });
  const classeA = linhasAbc.filter((l) => l.classe === 'A').length;
  r.resumo = [
    { rotulo: 'Faturamento dos produtos', valor: total.toFixed(2), tipo: 'moeda' },
    { rotulo: 'Lucro bruto', valor: total.minus(totCusto).toFixed(2), tipo: 'moeda' },
    { rotulo: 'Produtos vendidos', valor: String(prods.length), tipo: 'int' },
    { rotulo: 'Produtos classe A', valor: String(classeA), tipo: 'int' },
  ];
  r.observacoes.push('Classe A = produtos que somam os primeiros 80% do faturamento; B = até 95%; C = o resto. Valores já com o desconto rateado.');
  r.observacoes.push('Lucro bruto por produto usa o custo do orçamento (o custo real fica na Rentabilidade por pedido).');
  return r;
}

// ------------------------------------------------------------------ 8. Clientes (CRM)

async function clientes(db: Banco, lojaId: string, f: Filtros): Promise<Relatorio> {
  const usarPeriodo = f.usarPeriodo ?? false;
  const filtrosTxt: string[] = [];
  if (usarPeriodo) filtrosTxt.push(`compra de ${br(f.de)} a ${br(f.ate)}`);
  if (f.instalacaoDe || f.instalacaoAte) filtrosTxt.push(`instalação ${f.instalacaoDe ? `de ${br(f.instalacaoDe)} ` : ''}${f.instalacaoAte ? `até ${br(f.instalacaoAte)}` : ''}`.trim());
  if (f.nome) filtrosTxt.push(`nome "${f.nome}"`);
  if (f.telefone) filtrosTxt.push(`telefone "${f.telefone}"`);
  if (f.bairro) filtrosTxt.push(`bairro "${f.bairro}"`);
  if (f.produto) filtrosTxt.push(`produto "${f.produto}"`);
  if (f.forma) filtrosTxt.push(`forma ${NOME_FORMA[f.forma] ?? f.forma}`);
  const r = base('clientes', f, filtrosTxt.length ? filtrosTxt.join(', ') : 'Todos os clientes');
  const like = (t?: string) => (t ? `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);
  const tel = f.telefone?.replace(/\D/g, '') || null;
  const rows = await linhas<{ cliente: string; telefone: string; bairro: string | null; pedido: string | null; compra: string | null; instalacao: string | null; forma: string | null; valor: string | null; produtos: string | null; status: string | null }>(db, sql`
    SELECT v.nome_completo AS cliente, v.telefone_whatsapp AS telefone, c.bairro, v.numero_pedido AS pedido,
           to_char((v.data_compra AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS compra,
           to_char((v.data_instalacao AT TIME ZONE ${FUSO})::date, 'YYYY-MM-DD') AS instalacao,
           v.forma_pagamento AS forma, v.valor_total_final::text AS valor, v.produtos_comprados AS produtos, v.status_operacional AS status
      FROM vw_clientes_historico_pesquisa v JOIN clientes c ON c.id = v.cliente_id
     WHERE c.loja_id = ${lojaId} AND c.ativo AND (v.status_operacional IS NULL OR v.status_operacional <> 'CANCELADO')
       AND (${like(f.nome)}::text IS NULL OR c.nome_busca LIKE f_busca(${like(f.nome)}))
       AND (${tel}::text IS NULL OR regexp_replace(COALESCE(v.telefone_whatsapp, '') || ' ' || COALESCE(c.telefone_secundario, ''), '\\D', '', 'g') LIKE ${tel ? `%${tel}%` : null})
       AND (${like(f.bairro)}::text IS NULL OR f_busca(COALESCE(c.bairro, '')) LIKE f_busca(${like(f.bairro)}))
       AND (${like(f.produto)}::text IS NULL OR f_busca(COALESCE(v.produtos_comprados, '')) LIKE f_busca(${like(f.produto)}))
       AND (${f.forma ?? null}::text IS NULL OR v.forma_pagamento::text = ${f.forma ?? null})
       AND (NOT ${usarPeriodo}::boolean OR (v.data_compra AT TIME ZONE ${FUSO})::date BETWEEN ${f.de}::date AND ${f.ate}::date)
       AND (${f.instalacaoDe ?? null}::date IS NULL OR (v.data_instalacao AT TIME ZONE ${FUSO})::date >= ${f.instalacaoDe ?? null}::date)
       AND (${f.instalacaoAte ?? null}::date IS NULL OR (v.data_instalacao AT TIME ZONE ${FUSO})::date <= ${f.instalacaoAte ?? null}::date)
     ORDER BY v.nome_completo, v.data_compra DESC NULLS LAST LIMIT 1000`);
  r.tabelas.push({
    colunas: [
      { chave: 'cliente', titulo: 'Cliente', tipo: 'texto', peso: 2 }, { chave: 'telefone', titulo: 'Telefone', tipo: 'texto' },
      { chave: 'bairro', titulo: 'Bairro', tipo: 'texto' }, { chave: 'pedido', titulo: 'Pedido', tipo: 'texto' },
      { chave: 'compra', titulo: 'Compra', tipo: 'data' }, { chave: 'instalacao', titulo: 'Instalação', tipo: 'data' },
      { chave: 'forma', titulo: 'Pagamento', tipo: 'texto' }, { chave: 'valor', titulo: 'Valor', tipo: 'moeda' },
      { chave: 'produtos', titulo: 'Produtos', tipo: 'texto', peso: 4 },
    ],
    linhas: rows.map((x) => ({
      ...x, bairro: x.bairro ?? '', pedido: x.pedido ? `${x.pedido}${x.status && x.status !== 'INSTALADO_CONCLUIDO' ? ` (${STATUS_PEDIDO[x.status]?.toLowerCase() ?? x.status})` : ''}` : 'Sem pedido',
      forma: x.forma ? NOME_FORMA[x.forma] ?? x.forma : '', valor: x.valor, produtos: x.produtos ?? '',
    })),
    vazio: 'Nenhum cliente com esses filtros.',
  });
  const nClientes = new Set(rows.map((x) => `${x.cliente}|${x.telefone}`)).size;
  const comPedido = rows.filter((x) => x.pedido);
  r.resumo = [
    { rotulo: 'Clientes', valor: String(nClientes), tipo: 'int' },
    { rotulo: 'Pedidos', valor: String(comPedido.length), tipo: 'int' },
    { rotulo: 'Valor comprado', valor: soma(comPedido.map((x) => d(x.valor ?? 0))).toFixed(2), tipo: 'moeda' },
  ];
  if (rows.length === 1000) r.observacoes.push('Mostrando os primeiros 1.000 resultados: use mais filtros.');
  return r;
}

export type { Kpi, Tabela };
