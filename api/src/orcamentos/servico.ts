import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  calcularItem, checarLiberacao, d, descricaoComercial, garantiaDoItem, ErroEntrada, LIMITES_SEMAFORO_PADRAO, ratearDesconto, totalizarOrcamento,
  type Ajuste, type Catalogo, type EntradaItem,
} from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import type { UsuarioSessao } from '../auth/sessao.js';
import { pode } from '../auth/permissoes.js';
import { carregarCatalogoDoBanco } from '../catalogo/catalogo-banco.js';
import { parametro } from '../catalogo/parametros.js';
import { hashItem, jsonEstavel, type DocumentoEntrada, type ItemDocumento } from './esquemas.js';

/**
 * Regras do configurador de orçamento (especificação v1.1: seções 1, 9, 11.1 e 12).
 * - O orçamento é um projeto (cliente + obra) com itens agrupados por ambiente.
 * - Cada item guarda o que o vendedor escolheu (entrada + ajustes) e o snapshot do BOM:
 *   item que não mudou NÃO é recalculado, então reajuste do catálogo não mexe no que já foi orçado.
 * - Só o rascunho da versão mais nova é editável. Versão enviada fica congelada; editar
 *   uma versão congelada, antiga ou alterada em outro aparelho cria a próxima versão (v2, v3...).
 * - Toda mudança vai para `orcamento_auditoria`.
 */

type Tx = Parameters<Parameters<Banco['transaction']>[0]>[0];
type Exec = Banco | Tx;

export class ErroOrcamento extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); }
}

const ESTADOS_FINAIS = new Set(['APROVADO', 'PERDIDO', 'EXPIRADO']);
export const TRANSICOES: Record<string, string[]> = {
  RASCUNHO: ['ENVIADO', 'PERDIDO'],
  ENVIADO: ['AGUARDANDO_MEDICAO', 'EM_NEGOCIACAO', 'PERDIDO'],
  AGUARDANDO_MEDICAO: ['EM_NEGOCIACAO', 'PERDIDO'],
  EM_NEGOCIACAO: ['PERDIDO'],
};

async function linhas<T>(db: Exec, q: SQL): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

// ------------------------------------------------------------------ parâmetros de margem

export async function parametrosMargem(db: Exec, lojaId: string, vendedorId: string, forma: string | null, parcelas: number) {
  const p = (k: string) => parametro(db as Banco, lojaId, k);
  const [v] = await linhas<{ comissao: string | null; descontoMax: string | null }>(db,
    sql`SELECT comissao_padrao AS comissao, desconto_max_pct AS "descontoMax" FROM usuarios WHERE id = ${vendedorId}`);
  let taxaPct = '0';
  // Cartão com a taxa repassada ao cliente (REPASSAR_TAXA_CARTAO = 1): a loja recebe o mesmo que no PIX,
  // então a taxa não reduz a margem do orçamento.
  const cartao = forma != null && ['DEBITO', 'CREDITO_AVISTA', 'CREDITO_PARCELADO'].includes(forma);
  const repasse = cartao && d((await p('REPASSAR_TAXA_CARTAO')) ?? 0).gt(0);
  if (forma && !repasse) {
    const [t] = await linhas<{ taxa: string }>(db, sql`
      SELECT (taxa_mdr_pct + taxa_antecip_pct)::text AS taxa FROM taxas_pagamento
       WHERE forma_pagamento = ${forma} AND parcelas = ${parcelas} AND bandeira IN ('TODAS', 'VISA_MASTER')`);
    taxaPct = t?.taxa ?? '0';
  }
  return {
    taxaPagamentoPct: taxaPct,
    aliquotaImpostoPct: (await p('ALIQUOTA_IMPOSTO_VENDA_PCT')) ?? '0',
    comissaoPct: v?.comissao ?? '0',
    descontoMaxPct: v?.descontoMax ?? null,
    limites: {
      verdeMinPct: (await p('SEMAFORO_VERDE_MIN_PCT')) ?? LIMITES_SEMAFORO_PADRAO.verdeMinPct,
      amareloMinPct: (await p('SEMAFORO_AMARELO_MIN_PCT')) ?? LIMITES_SEMAFORO_PADRAO.amareloMinPct,
    },
  };
}

// ------------------------------------------------------------------ leitura

type Cabecalho = {
  id: string; grupoId: string; lojaId: string; codigo: string; versao: number; origemId: string | null; status: string;
  titulo: string | null; clienteId: string; clienteNome: string; clienteTelefone: string; vendedorId: string; vendedorNome: string;
  dataCriacao: string; atualizadoEm: string; validadeAte: string | null; enviadoEm: string | null; congeladoEm: string | null;
  motivoPerda: string | null;
  descontoTipo: 'PERCENTUAL' | 'VALOR'; descontoInformado: string; descontoValor: string; descontoPct: string; acrescimo: string;
  subtotal: string; total: string; custoTotal: string; lucroBruto: string; margemBrutaPct: string; margemLiquidaPct: string;
  taxaPct: string; taxaValor: string; impostoValor: string; comissaoPct: string; comissaoValor: string; lucroLiquido: string;
  semaforo: string | null; formaPagamento: string | null; parcelas: number | null;
  prazoEntregaDias: number | null; garantiaTexto: string | null; condicoesPagamentoTexto: string | null;
  observacoesCliente: string | null; observacoesInternas: string | null; medidasConferidas: boolean;
  liberadoPorId: string | null; liberadoPorNome: string | null; liberadoEm: string | null;
  liberadoMargemPct: string | null; liberadoDescontoPct: string | null; descontoMaxPct: string | null;
  ultimaOperacaoId: string | null; versaoMaisNovaId: string; versaoMaisNova: number;
  /** Rascunho aberto como aditivo de um pedido (vira pedido ao confirmar no pedido). */
  aditivoPedidoId: string | null;
  /** Pedido do projeto (se já foi aprovado). */
  pedidoId: string | null; pedidoNumero: string | null;
};

const SELECT_CABECALHO = sql`
  SELECT o.id, o.grupo_id AS "grupoId", o.loja_id AS "lojaId", o.codigo_sequencial AS codigo, o.versao,
         o.orcamento_origem_id AS "origemId", o.status, o.titulo,
         o.cliente_id AS "clienteId", c.nome_completo AS "clienteNome", c.telefone_whatsapp AS "clienteTelefone",
         o.vendedor_id AS "vendedorId", u.nome AS "vendedorNome",
         o.data_criacao AS "dataCriacao", to_char(o.atualizado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "atualizadoEm",
         to_char(o.validade_ate, 'YYYY-MM-DD') AS "validadeAte", o.enviado_em AS "enviadoEm", o.congelado_em AS "congeladoEm",
         o.motivo_perda AS "motivoPerda",
         o.desconto_tipo AS "descontoTipo", o.desconto_informado AS "descontoInformado",
         o.desconto_valor AS "descontoValor", o.desconto_percentual AS "descontoPct", o.acrescimo_outros AS acrescimo,
         o.subtotal_venda AS subtotal, o.valor_total_venda AS total, o.custo_total_previsto AS "custoTotal",
         o.lucro_bruto_previsto AS "lucroBruto", o.margem_bruta_pct AS "margemBrutaPct", o.margem_prevista_pct AS "margemLiquidaPct",
         o.taxa_financeira_pct AS "taxaPct", o.taxa_pagamento_valor AS "taxaValor", o.imposto_valor AS "impostoValor",
         o.comissao_pct AS "comissaoPct", o.comissao_valor AS "comissaoValor", o.lucro_liquido_previsto AS "lucroLiquido",
         o.semaforo, o.forma_pagamento_prevista AS "formaPagamento", o.parcelas,
         o.prazo_entrega_dias AS "prazoEntregaDias", o.garantia_texto AS "garantiaTexto",
         o.condicoes_pagamento_texto AS "condicoesPagamentoTexto",
         o.observacoes_cliente AS "observacoesCliente", o.observacoes_internas AS "observacoesInternas",
         o.medidas_conferidas AS "medidasConferidas",
         o.liberado_por_id AS "liberadoPorId", lib.nome AS "liberadoPorNome", o.liberado_em AS "liberadoEm",
         o.liberado_margem_pct AS "liberadoMargemPct", o.liberado_desconto_pct AS "liberadoDescontoPct",
         u.desconto_max_pct AS "descontoMaxPct", o.ultima_operacao_id AS "ultimaOperacaoId",
         ult.id AS "versaoMaisNovaId", ult.versao AS "versaoMaisNova",
         o.aditivo_pedido_id AS "aditivoPedidoId", ped.id AS "pedidoId", ped.numero_pedido AS "pedidoNumero"
    FROM orcamentos o
    JOIN clientes c ON c.id = o.cliente_id
    JOIN usuarios u ON u.id = o.vendedor_id
    LEFT JOIN usuarios lib ON lib.id = o.liberado_por_id
    JOIN LATERAL (SELECT id, versao FROM orcamentos x WHERE x.grupo_id = o.grupo_id ORDER BY versao DESC LIMIT 1) ult ON TRUE
    LEFT JOIN pedidos ped ON ped.grupo_orcamento_id = o.grupo_id`;

type LinhaItem = {
  id: string; ambiente: string; tipo: 'CORTINA' | 'PERSIANA'; descricaoComercial: string; ordem: number;
  larguraBruta: string | null; alturaBruta: string | null; larguraProducao: string; alturaProducao: string;
  entrada: Record<string, unknown>; ajustes: Ajuste[]; hash: string | null; alertas: unknown[]; especificacaoTecnica: Record<string, unknown>;
  custoTotal: string; vendaTotal: string; descontoRateado: string; vendaLiquida: string; calculadoEm: string;
};
type LinhaComponente = {
  id: string; itemId: string; produtoId: string; fornecedorId: string | null; sku: string; descricao: string; unidade: string;
  quantidadeCalculada: string | null; quantidadeOverride: string | null; quantidade: string; formulaLog: string | null;
  custoUnitario: string; custoTotal: string; precoUnitario: string; precoTotal: string;
  descontoRateado: string; precoTotalLiquido: string; origem: 'MOTOR' | 'MANUAL'; ordem: number;
};

async function lerItens(db: Exec, orcamentoId: string) {
  const itens = await linhas<LinhaItem>(db, sql`
    SELECT id, ambiente, tipo_item AS tipo, descricao_comercial AS "descricaoComercial", ordem,
           largura_bruta_m AS "larguraBruta", altura_bruta_m AS "alturaBruta",
           largura_producao_m AS "larguraProducao", altura_producao_m AS "alturaProducao",
           entrada_calculo AS entrada, ajustes, hash_entrada AS hash, alertas, especificacoes_tecnicas AS "especificacaoTecnica",
           custo_total_item AS "custoTotal", venda_total_item AS "vendaTotal", desconto_rateado AS "descontoRateado",
           venda_liquida_item AS "vendaLiquida", calculado_em AS "calculadoEm"
      FROM orcamento_itens_compostos WHERE orcamento_id = ${orcamentoId} ORDER BY ordem, id`);
  const comps = itens.length === 0 ? [] : await linhas<LinhaComponente>(db, sql`
    SELECT oc.id, oc.item_composto_id AS "itemId", oc.produto_id AS "produtoId", oc.fornecedor_id AS "fornecedorId",
           oc.sku_snapshot AS sku, oc.descricao_snapshot AS descricao, oc.unidade_medida_snapshot AS unidade,
           oc.quantidade_calculada AS "quantidadeCalculada", oc.quantidade_override AS "quantidadeOverride",
           oc.quantidade_final AS quantidade, oc.formula_aplicada_log AS "formulaLog",
           oc.custo_unitario_snapshot AS "custoUnitario", oc.custo_total AS "custoTotal",
           oc.preco_unitario_snapshot AS "precoUnitario", oc.preco_total AS "precoTotal",
           oc.desconto_rateado AS "descontoRateado", oc.preco_total_liquido AS "precoTotalLiquido", oc.origem, oc.ordem
      FROM orcamento_componentes oc JOIN orcamento_itens_compostos i ON i.id = oc.item_composto_id
     WHERE i.orcamento_id = ${orcamentoId} ORDER BY oc.ordem`);
  return itens.map((i) => ({ ...i, componentes: comps.filter((c) => c.itemId === i.id) }));
}
export type ItemCompleto = Awaited<ReturnType<typeof lerItens>>[number];

export async function lerCabecalho(db: Exec, id: string): Promise<Cabecalho | null> {
  const [c] = await linhas<Cabecalho>(db, sql`${SELECT_CABECALHO} WHERE o.id = ${id}`);
  return c ?? null;
}

/** O usuário pode ver/editar este orçamento? VENDEDOR: só os próprios. */
export function noEscopo(u: UsuarioSessao, c: { lojaId: string; vendedorId: string }) {
  return c.lojaId === u.lojaId && (pode(u, 'orcamentos.todos') || c.vendedorId === u.id);
}

export function situacaoLiberacao(c: Cabecalho) {
  const t = { semaforo: (c.semaforo ?? 'VERDE') as 'VERDE' | 'AMARELO' | 'VERMELHO', descontoPct: d(c.descontoPct), margemLiquidaPct: d(c.margemLiquidaPct) };
  const ch = checarLiberacao(t, c.descontoMaxPct);
  const liberado = Boolean(c.liberadoEm)
    && t.margemLiquidaPct.gte(d(c.liberadoMargemPct ?? '999'))
    && t.descontoPct.lte(d(c.liberadoDescontoPct ?? '-1'));
  return { exige: ch.exige, motivos: ch.motivos, liberado, pendente: ch.exige && !liberado };
}

export async function lerDocumento(db: Exec, id: string) {
  const c = await lerCabecalho(db, id);
  if (!c) return null;
  const itens = await lerItens(db, id);
  return { c, itens };
}

/** Monta a resposta. Sem `custos.ver`: nada de custo, lucro, margem nem taxa (só o semáforo). */
export function documentoPublico(u: UsuarioSessao, doc: NonNullable<Awaited<ReturnType<typeof lerDocumento>>>) {
  const { c, itens } = doc;
  const verCusto = pode(u, 'custos.ver');
  const lib = situacaoLiberacao(c);
  const editavel = c.status === 'RASCUNHO' && !c.congeladoEm && c.versaoMaisNovaId === c.id;
  const semCusto = <T extends Record<string, unknown>>(o: T, chaves: string[]) => {
    if (verCusto) return o;
    const x = { ...o };
    for (const k of chaves) delete x[k];
    return x;
  };
  return {
    id: c.id, grupoId: c.grupoId, codigo: c.codigo, versao: c.versao, origemId: c.origemId, status: c.status, titulo: c.titulo,
    clienteId: c.clienteId, clienteNome: c.clienteNome, clienteTelefone: c.clienteTelefone,
    vendedorId: c.vendedorId, vendedorNome: c.vendedorNome,
    dataCriacao: c.dataCriacao, atualizadoEm: c.atualizadoEm, enviadoEm: c.enviadoEm, congeladoEm: c.congeladoEm, motivoPerda: c.motivoPerda,
    editavel, versaoMaisNovaId: c.versaoMaisNovaId, versaoMaisNova: c.versaoMaisNova,
    pedidoId: c.pedidoId, pedidoNumero: c.pedidoNumero,
    aditivo: ehRascunhoAditivo(c),
    podeVerCustos: verCusto,
    condicoes: {
      descontoTipo: c.descontoTipo, descontoValor: c.descontoInformado, acrescimo: c.acrescimo,
      formaPagamento: c.formaPagamento, parcelas: c.parcelas ?? 1, validadeAte: c.validadeAte,
      prazoEntregaDias: c.prazoEntregaDias, garantiaTexto: c.garantiaTexto, condicoesPagamentoTexto: c.condicoesPagamentoTexto,
      observacoesCliente: c.observacoesCliente, observacoesInternas: c.observacoesInternas, medidasConferidas: c.medidasConferidas,
    },
    itens: itens.map(({ hash: _h, componentes, ...i }) => ({
      ...semCusto(i, ['custoTotal']),
      componentes: componentes.map(({ itemId: _i, produtoId: _p, fornecedorId: _f, ...comp }) => semCusto(comp, ['custoUnitario', 'custoTotal'])),
    })),
    totais: semCusto({
      subtotal: c.subtotal, descontoValor: c.descontoValor, descontoPct: c.descontoPct, acrescimo: c.acrescimo, total: c.total,
      custoTotal: c.custoTotal, lucroBruto: c.lucroBruto, margemBrutaPct: c.margemBrutaPct,
      taxaPagamentoPct: c.taxaPct, taxaPagamento: c.taxaValor, imposto: c.impostoValor,
      comissaoPct: c.comissaoPct, comissao: c.comissaoValor, lucroLiquido: c.lucroLiquido, margemLiquidaPct: c.margemLiquidaPct,
      semaforo: c.semaforo ?? 'VERDE',
    }, ['custoTotal', 'lucroBruto', 'margemBrutaPct', 'taxaPagamentoPct', 'taxaPagamento', 'imposto', 'comissaoPct', 'comissao', 'lucroLiquido', 'margemLiquidaPct']),
    liberacao: {
      ...lib,
      // O motivo cita a margem em %; quem não vê custo vê só que ficou vermelha.
      motivos: verCusto ? lib.motivos : lib.motivos.map((m) => (m.startsWith('Margem') ? 'Margem vermelha.' : m)),
      liberadoPorNome: lib.liberado ? c.liberadoPorNome : null,
      liberadoEm: lib.liberado ? c.liberadoEm : null,
    },
  };
}
export type DocumentoPublico = ReturnType<typeof documentoPublico>;

// ------------------------------------------------------------------ auditoria

type RegistroAuditoria = { acao: string; descricao: string; itemId?: string | null; detalhes?: Record<string, unknown> };

export async function auditar(db: Exec, orcamentoId: string, usuarioId: string, regs: RegistroAuditoria[], offline = false) {
  for (const r of regs) {
    await db.execute(sql`
      INSERT INTO orcamento_auditoria (orcamento_id, item_id, usuario_id, acao, descricao, detalhes, offline)
      VALUES (${orcamentoId}, ${r.itemId ?? null}, ${usuarioId}, ${r.acao}, ${r.descricao}, ${JSON.stringify(r.detalhes ?? {})}::jsonb, ${offline})`);
  }
}

function descreverAjuste(a: Ajuste): string {
  const m = a.motivo ? ` (motivo: ${a.motivo})` : '';
  switch (a.tipo) {
    case 'QUANTIDADE': return `Quantidade de ${a.sku} alterada para ${a.quantidade}${m}`;
    case 'REMOVER': return `${a.sku} removido${m}`;
    case 'ADICIONAR': return `${a.sku} incluído (${a.quantidade})${m}`;
    case 'SUBSTITUIR': return `${a.sku} trocado por ${a.novoSku}${m}`;
    default: return 'Ajuste';
  }
}

const ROTULOS_CONDICOES: Record<string, string> = {
  descontoTipo: 'tipo de desconto', descontoValor: 'desconto', acrescimo: 'acréscimo', formaPagamento: 'forma de pagamento',
  parcelas: 'parcelas', validadeAte: 'validade', prazoEntregaDias: 'prazo de entrega', garantiaTexto: 'garantia',
  condicoesPagamentoTexto: 'condições de pagamento', observacoesCliente: 'observações ao cliente',
  observacoesInternas: 'observações internas', medidasConferidas: 'medidas conferidas',
};

function diferencas(base: Awaited<ReturnType<typeof lerDocumento>> | null, novo: DocumentoEntrada): RegistroAuditoria[] {
  if (!base) return [{ acao: 'CRIADO', descricao: `Orçamento criado com ${novo.itens.length} item(ns).` }];
  const regs: RegistroAuditoria[] = [];
  if (base.c.clienteId !== novo.clienteId) regs.push({ acao: 'CLIENTE_ALTERADO', descricao: 'Cliente trocado.', detalhes: { de: base.c.clienteId, para: novo.clienteId } });
  if ((base.c.titulo ?? '') !== (novo.titulo ?? '')) regs.push({ acao: 'TITULO_ALTERADO', descricao: `Projeto: "${novo.titulo ?? ''}".` });
  const antes: Record<string, unknown> = {
    descontoTipo: base.c.descontoTipo, descontoValor: d(base.c.descontoInformado).toFixed(2), acrescimo: d(base.c.acrescimo).toFixed(2),
    formaPagamento: base.c.formaPagamento ?? null, parcelas: base.c.parcelas ?? 1, validadeAte: base.c.validadeAte ?? null,
    prazoEntregaDias: base.c.prazoEntregaDias ?? null, garantiaTexto: base.c.garantiaTexto ?? null,
    condicoesPagamentoTexto: base.c.condicoesPagamentoTexto ?? null, observacoesCliente: base.c.observacoesCliente ?? null,
    observacoesInternas: base.c.observacoesInternas ?? null, medidasConferidas: base.c.medidasConferidas,
  };
  const depois: Record<string, unknown> = {
    ...novo.condicoes, descontoValor: d(novo.condicoes.descontoValor).toFixed(2), acrescimo: d(novo.condicoes.acrescimo).toFixed(2),
  };
  const mudou = Object.keys(antes).filter((k) => (antes[k] ?? null) !== (depois[k] ?? null));
  if (mudou.length) {
    regs.push({
      acao: mudou.some((k) => k.startsWith('desconto')) ? 'DESCONTO_ALTERADO' : 'CONDICOES_ALTERADAS',
      descricao: `Alterado: ${mudou.map((k) => ROTULOS_CONDICOES[k] ?? k).join(', ')}.`,
      detalhes: Object.fromEntries(mudou.map((k) => [k, { de: antes[k], para: depois[k] }])),
    });
  }
  const porId = new Map(base.itens.map((i) => [i.id, i]));
  const novos = new Set(novo.itens.map((i) => i.id));
  for (const i of base.itens) {
    if (!novos.has(i.id)) regs.push({ acao: 'ITEM_REMOVIDO', itemId: i.id, descricao: `Item removido: ${i.ambiente} - ${i.descricaoComercial}.` });
  }
  for (const i of novo.itens) {
    const b = porId.get(i.id);
    if (!b) { regs.push({ acao: 'ITEM_INCLUIDO', itemId: i.id, descricao: `Item incluído em ${i.ambiente} (${i.tipo === 'CORTINA' ? 'cortina' : 'persiana'}).` }); continue; }
    if (b.ambiente !== i.ambiente) regs.push({ acao: 'ITEM_ALTERADO', itemId: i.id, descricao: `Item mudou de ambiente: ${b.ambiente} -> ${i.ambiente}.` });
    if (jsonEstavel(b.entrada) !== jsonEstavel(i.entrada)) {
      regs.push({ acao: 'ITEM_ALTERADO', itemId: i.id, descricao: `Medidas/opções alteradas em ${i.ambiente}.`, detalhes: { de: b.entrada, para: i.entrada } });
    }
    if (i.descricaoComercial && i.descricaoComercial !== b.descricaoComercial) {
      regs.push({ acao: 'ITEM_ALTERADO', itemId: i.id, descricao: `Descrição do item: "${i.descricaoComercial}".` });
    }
    const ja = new Set(b.ajustes.map((a) => jsonEstavel(a)));
    const agora = new Set(i.ajustes.map((a) => jsonEstavel(a)));
    for (const a of i.ajustes) {
      if (!ja.has(jsonEstavel(a))) regs.push({ acao: 'COMPONENTE_AJUSTADO', itemId: i.id, descricao: `${i.ambiente}: ${descreverAjuste(a as Ajuste)}.`, detalhes: { ajuste: a } });
    }
    for (const a of b.ajustes) {
      if (!agora.has(jsonEstavel(a))) regs.push({ acao: 'AJUSTE_DESFEITO', itemId: i.id, descricao: `${i.ambiente}: desfeito "${descreverAjuste(a)}".`, detalhes: { ajuste: a } });
    }
  }
  return regs;
}

// ------------------------------------------------------------------ gravação

async function proximoCodigo(db: Exec): Promise<string> {
  const [r] = await linhas<{ n: string }>(db, sql`SELECT nextval('orcamento_numero_seq')::text AS n`);
  return `ORC-${new Date().getFullYear()}-${r!.n.padStart(4, '0')}`;
}

async function clienteDoEscopo(db: Exec, u: UsuarioSessao, clienteId: string) {
  const [c] = await linhas<{ id: string }>(db, sql`
    SELECT id FROM clientes WHERE id = ${clienteId} AND loja_id = ${u.lojaId} AND ativo
       AND (${pode(u, 'clientes.todos')}::boolean OR vendedor_responsavel_id = ${u.id})`);
  return Boolean(c);
}

/** Rascunho aberto como aditivo de pedido: não é enviado nem aprovado pelo orçamento, e sim no pedido. */
export function ehRascunhoAditivo(c: Pick<Cabecalho, 'status' | 'aditivoPedidoId'>) {
  return c.status === 'RASCUNHO' && Boolean(c.aditivoPedidoId);
}

/** Copia o cabeçalho para a próxima versão (rascunho). Itens: copia o snapshot ou nenhum. */
export async function criarVersao(tx: Tx, origem: Cabecalho, u: UsuarioSessao, copiarItens: boolean): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO orcamentos (id, loja_id, codigo_sequencial, versao, orcamento_origem_id, grupo_id, cliente_id, vendedor_id, status,
      titulo, criado_por_id, validade_ate, desconto_tipo, desconto_informado, desconto_valor, desconto_percentual, acrescimo_outros,
      forma_pagamento_prevista, parcelas, prazo_entrega_dias, garantia_texto, condicoes_pagamento_texto,
      observacoes_cliente, observacoes_internas, medidas_conferidas,
      liberado_por_id, liberado_em, liberado_margem_pct, liberado_desconto_pct, aditivo_pedido_id)
    SELECT ${id}, loja_id, codigo_sequencial,
           (SELECT MAX(versao) + 1 FROM orcamentos WHERE grupo_id = ${origem.grupoId}), ${origem.id}, grupo_id, cliente_id, vendedor_id,
           'RASCUNHO', titulo, ${u.id}, NULL, desconto_tipo, desconto_informado, desconto_valor, desconto_percentual, acrescimo_outros,
           forma_pagamento_prevista, parcelas, prazo_entrega_dias, garantia_texto, condicoes_pagamento_texto,
           observacoes_cliente, observacoes_internas, medidas_conferidas,
           -- A liberação do ADMIN segue valendo enquanto margem e desconto não piorarem.
           liberado_por_id, liberado_em, liberado_margem_pct, liberado_desconto_pct,
           -- Conflito dentro de um aditivo continua sendo o aditivo do mesmo pedido.
           CASE WHEN status = 'RASCUNHO' THEN aditivo_pedido_id END
      FROM orcamentos WHERE id = ${origem.id}`);
  if (copiarItens) {
    for (const i of await lerItens(tx, origem.id)) await inserirItem(tx, id, randomUUID(), i, i.componentes);
  }
  return id;
}

type ComponenteGravar = Omit<LinhaComponente, 'id' | 'itemId' | 'descontoRateado' | 'precoTotalLiquido' | 'ordem' | 'produtoId' | 'fornecedorId'>;

async function inserirItem(
  tx: Tx, orcamentoId: string, itemId: string,
  i: Pick<LinhaItem, 'ambiente' | 'tipo' | 'descricaoComercial' | 'ordem' | 'larguraBruta' | 'alturaBruta' | 'larguraProducao' | 'alturaProducao' | 'entrada' | 'ajustes' | 'alertas' | 'especificacaoTecnica' | 'custoTotal' | 'vendaTotal'> & { hash: string | null },
  comps: ComponenteGravar[],
) {
  await tx.execute(sql`
    INSERT INTO orcamento_itens_compostos (id, orcamento_id, ambiente, tipo_item, descricao_comercial, largura_bruta_m, altura_bruta_m,
      largura_producao_m, altura_producao_m, especificacoes_tecnicas, custo_total_item, venda_total_item, ordem,
      entrada_calculo, ajustes, hash_entrada, alertas)
    VALUES (${itemId}, ${orcamentoId}, ${i.ambiente}, ${i.tipo}, ${i.descricaoComercial}, ${i.larguraBruta}, ${i.alturaBruta},
      ${i.larguraProducao}, ${i.alturaProducao}, ${JSON.stringify(i.especificacaoTecnica)}::jsonb, ${i.custoTotal}, ${i.vendaTotal}, ${i.ordem},
      ${JSON.stringify(i.entrada)}::jsonb, ${JSON.stringify(i.ajustes)}::jsonb, ${i.hash}, ${JSON.stringify(i.alertas)}::jsonb)`);
  if (comps.length === 0) return;
  const valores = comps.map((c, n) => sql`(
    ${itemId}, (SELECT id FROM produtos WHERE sku = ${c.sku}), (SELECT fornecedor_padrao_id FROM produtos WHERE sku = ${c.sku}),
    ${c.sku}, ${c.descricao}, ${c.unidade}::unidade_medida_enum, ${c.quantidadeCalculada}, ${c.quantidadeOverride}, ${c.quantidade},
    ${(c.formulaLog ?? '').slice(0, 255)}, ${c.custoUnitario}, ${c.custoTotal}, ${c.precoUnitario}, ${c.precoTotal}, ${c.precoTotal},
    ${c.origem}, ${n + 1})`);
  await tx.execute(sql`
    INSERT INTO orcamento_componentes (item_composto_id, produto_id, fornecedor_id, sku_snapshot, descricao_snapshot, unidade_medida_snapshot,
      quantidade_calculada, quantidade_override, quantidade_final, formula_aplicada_log, custo_unitario_snapshot, custo_total,
      preco_unitario_snapshot, preco_total, preco_total_liquido, origem, ordem)
    VALUES ${sql.join(valores, sql`, `)}`);
}

/** Recalcula totais, rateio e semáforo a partir do snapshot gravado. */
export async function recalcularTotais(tx: Exec, orcamentoId: string) {
  const c = (await lerCabecalho(tx, orcamentoId))!;
  const itens = await lerItens(tx, orcamentoId);
  const p = await parametrosMargem(tx, c.lojaId, c.vendedorId, c.formaPagamento, c.parcelas ?? 1);
  const t = totalizarOrcamento(itens, { descontoTipo: c.descontoTipo, descontoValor: c.descontoInformado, acrescimo: c.acrescimo }, p);
  const rateio = ratearDesconto(itens.map((i) => ({ id: i.id, vendaTotal: i.vendaTotal, componentes: i.componentes })), t.descontoValor);
  for (const r of rateio) {
    await tx.execute(sql`UPDATE orcamento_itens_compostos SET desconto_rateado = ${r.descontoRateado.toFixed(2)},
      venda_liquida_item = ${r.vendaLiquida.toFixed(2)} WHERE id = ${r.id}`);
    if (r.componentes.length) {
      const vals = r.componentes.map((x) => sql`(${x.id}::uuid, ${x.descontoRateado.toFixed(2)}::numeric, ${x.precoTotalLiquido.toFixed(2)}::numeric)`);
      await tx.execute(sql`UPDATE orcamento_componentes oc SET desconto_rateado = v.dr, preco_total_liquido = v.pl
        FROM (VALUES ${sql.join(vals, sql`, `)}) AS v(id, dr, pl) WHERE oc.id = v.id`);
    }
  }
  await tx.execute(sql`UPDATE orcamentos SET
      subtotal_venda = ${t.subtotal.toFixed(2)}, desconto_valor = ${t.descontoValor.toFixed(2)}, desconto_percentual = ${t.descontoPct.toFixed(2)},
      valor_total_venda = ${t.total.toFixed(2)}, custo_total_previsto = ${t.custoTotal.toFixed(2)},
      lucro_bruto_previsto = ${t.lucroBruto.toFixed(2)}, margem_bruta_pct = ${t.margemBrutaPct.toFixed(2)},
      taxa_financeira_pct = ${d(p.taxaPagamentoPct).toFixed(2)}, taxa_pagamento_valor = ${t.taxaPagamento.toFixed(2)},
      imposto_valor = ${t.imposto.toFixed(2)}, comissao_pct = ${d(p.comissaoPct).toFixed(2)}, comissao_valor = ${t.comissao.toFixed(2)},
      lucro_liquido_previsto = ${t.lucroLiquido.toFixed(2)}, margem_prevista_pct = ${t.margemLiquidaPct.toFixed(2)}, semaforo = ${t.semaforo}
    WHERE id = ${orcamentoId}`);
  return t;
}

const f = (x: { toFixed(n: number): string }, n: number) => x.toFixed(n);

export type ResultadoSalvar = { id: string; novaVersao: boolean; motivoNovaVersao: string | null; repetido: boolean; avisos: string[] };

/**
 * Grava o orçamento inteiro (tela online ou fila offline). Cria se não existe.
 * Item com a mesma entrada e os mesmos ajustes mantém o snapshot; os outros são recalculados
 * com o catálogo vigente. Conflito ou versão congelada -> grava como a próxima versão.
 */
export async function salvarDocumento(db: Banco, u: UsuarioSessao, id: string, e: DocumentoEntrada): Promise<ResultadoSalvar> {
  return db.transaction(async (tx) => {
    if (e.idOperacao) {
      const [ja] = await linhas<{ id: string }>(tx, sql`SELECT id FROM orcamentos WHERE ultima_operacao_id = ${e.idOperacao}`);
      if (ja) return { id: ja.id, novaVersao: false, motivoNovaVersao: null, repetido: true, avisos: [] };
    }
    const [existe] = await linhas<{ id: string; grupoId: string }>(tx, sql`SELECT id, grupo_id AS "grupoId" FROM orcamentos WHERE id = ${id} FOR UPDATE`);
    let base: Awaited<ReturnType<typeof lerDocumento>> = null;
    let alvo = id;
    let motivo: string | null = null;
    const avisos: string[] = [];

    if (!existe) {
      if (!pode(u, 'orcamentos.proprios')) throw new ErroOrcamento('Seu perfil não cria orçamentos.', 403);
      if (!(await clienteDoEscopo(tx, u, e.clienteId))) throw new ErroOrcamento('Cliente não encontrado ou de outro vendedor.', 400);
      const validade = (await parametro(tx as unknown as Banco, u.lojaId, 'VALIDADE_ORCAMENTO_DIAS')) ?? '15';
      const prazo = (await parametro(tx as unknown as Banco, u.lojaId, 'PRAZO_ENTREGA_DIAS_UTEIS')) ?? '14';
      await tx.execute(sql`
        INSERT INTO orcamentos (id, grupo_id, loja_id, codigo_sequencial, versao, cliente_id, vendedor_id, criado_por_id,
          validade_ate, prazo_entrega_dias)
        VALUES (${id}, ${id}, ${u.lojaId}, ${await proximoCodigo(tx)}, 1, ${e.clienteId}, ${u.id}, ${u.id},
          CURRENT_DATE + ${Math.round(Number(validade))}::int, ${Math.round(Number(prazo))})`);
    } else {
      base = await lerDocumento(tx, id);
      if (!base || !noEscopo(u, base.c)) throw new ErroOrcamento('Orçamento não encontrado.', 404);
      await tx.execute(sql`SELECT id FROM orcamentos WHERE grupo_id = ${existe.grupoId} FOR UPDATE`);
      const c = base.c;
      if (c.versaoMaisNovaId !== c.id) motivo = `A v${c.versao} já tinha sido substituída pela v${c.versaoMaisNova}.`;
      else if (c.status !== 'RASCUNHO' || c.congeladoEm) motivo = `A v${c.versao} já foi enviada ao cliente e está congelada.`;
      else if (e.atualizadoEmBase && new Date(e.atualizadoEmBase).getTime() !== new Date(c.atualizadoEm).getTime()) {
        motivo = 'O orçamento foi alterado em outro lugar depois que você abriu. Suas mudanças viraram uma nova versão.';
      }
      if (ESTADOS_FINAIS.has(c.status) && c.versaoMaisNovaId === c.id && c.status !== 'EXPIRADO') {
        throw new ErroOrcamento(`Orçamento ${c.status === 'APROVADO' ? 'aprovado (vira pedido; mudança é aditivo)' : 'perdido'}: não pode ser alterado.`, 409);
      }
      if (motivo) {
        const ultimo = (await lerCabecalho(tx, c.versaoMaisNovaId))!;
        if (ESTADOS_FINAIS.has(ultimo.status) && ultimo.status !== 'EXPIRADO') {
          throw new ErroOrcamento(`A versão mais nova está ${ultimo.status.toLowerCase()}: não pode ser alterada.`, 409);
        }
        alvo = await criarVersao(tx, ultimo, u, false);
        avisos.push(motivo);
      }
      if (e.clienteId !== c.clienteId && !(await clienteDoEscopo(tx, u, e.clienteId))) {
        throw new ErroOrcamento('Cliente não encontrado ou de outro vendedor.', 400);
      }
    }

    // Cabeçalho
    const k = e.condicoes;
    await tx.execute(sql`UPDATE orcamentos SET
        cliente_id = ${e.clienteId}, titulo = ${e.titulo ?? null},
        desconto_tipo = ${k.descontoTipo}, desconto_informado = ${d(k.descontoValor).toFixed(2)}, acrescimo_outros = ${d(k.acrescimo).toFixed(2)},
        forma_pagamento_prevista = ${k.formaPagamento ?? null}, parcelas = ${k.parcelas},
        validade_ate = COALESCE(${k.validadeAte ?? null}::date, validade_ate), prazo_entrega_dias = CASE WHEN ${k.prazoEntregaDias === undefined} THEN prazo_entrega_dias ELSE ${k.prazoEntregaDias ?? null}::int END,
        garantia_texto = ${k.garantiaTexto ?? null}, condicoes_pagamento_texto = ${k.condicoesPagamentoTexto ?? null},
        observacoes_cliente = ${k.observacoesCliente ?? null}, observacoes_internas = ${k.observacoesInternas ?? null},
        medidas_conferidas = ${k.medidasConferidas}, ultima_operacao_id = ${e.idOperacao ?? null},
        atualizado_em = date_trunc('milliseconds', clock_timestamp())
      WHERE id = ${alvo}`);

    // Itens: snapshot mantido para o que não mudou; o resto passa pelo motor.
    const baseItens = new Map((base?.itens ?? []).map((i) => [i.id, i]));
    let catalogo: Catalogo | null = null;
    const cat = async () => (catalogo ??= (await carregarCatalogoDoBanco(tx as unknown as Banco)).catalogo);
    await tx.execute(sql`DELETE FROM orcamento_itens_compostos WHERE orcamento_id = ${alvo}`);
    let recalculados = 0;
    for (const [n, item] of e.itens.entries()) {
      const hash = hashItem(item);
      const b = baseItens.get(item.id);
      const itemId = alvo === id ? item.id : randomUUID();
      const entradaMotor = { tipo: item.tipo, entrada: item.entrada } as EntradaItem;
      if (b && b.hash === hash && !e.atualizarPrecos) {
        await inserirItem(tx, alvo, itemId, {
          ...b, ambiente: item.ambiente, ordem: n + 1, hash,
          descricaoComercial: item.descricaoComercial || b.descricaoComercial,
        }, b.componentes);
        continue;
      }
      let r;
      try {
        r = calcularItem(entradaMotor, item.ajustes as Ajuste[], await cat());
      } catch (erro) {
        if (erro instanceof ErroEntrada) throw new ErroOrcamento(`${item.ambiente}: ${erro.message}`, 400, { itemId: item.id });
        throw erro;
      }
      recalculados++;
      await inserirItem(tx, alvo, itemId, {
        ambiente: item.ambiente, tipo: item.tipo, ordem: n + 1, hash,
        descricaoComercial: item.descricaoComercial || descricaoComercial(entradaMotor, await cat()),
        larguraBruta: r.larguraBruta ? f(r.larguraBruta, 4) : null, alturaBruta: r.alturaBruta ? f(r.alturaBruta, 4) : null,
        larguraProducao: f(r.larguraProducao, 4), alturaProducao: f(r.alturaProducao, 4),
        entrada: item.entrada as Record<string, unknown>, ajustes: item.ajustes as Ajuste[],
        alertas: r.alertas,
        // Garantia congelada no item (vai para o PDF): regra do Gabriel, 27/11/2026.
        especificacaoTecnica: { ...r.especificacaoTecnica, garantia: garantiaDoItem(r.componentes.map((c) => c.sku), await cat()) },
        custoTotal: f(r.custoTotal, 2), vendaTotal: f(r.vendaTotal, 2),
      }, r.componentes.map((c) => ({
        sku: c.sku, descricao: c.descricao, unidade: c.unidade,
        quantidadeCalculada: c.quantidadeCalculada ? f(c.quantidadeCalculada, 4) : null,
        quantidadeOverride: c.quantidadeOverride ? f(c.quantidadeOverride, 4) : null,
        quantidade: f(c.quantidade, 4), formulaLog: c.formulaLog,
        custoUnitario: f(c.custoUnitario, 4), custoTotal: f(c.custoTotal, 2),
        precoUnitario: f(c.precoUnitario, 4), precoTotal: f(c.precoTotal, 2), origem: c.origem,
      })));
    }

    const t = await recalcularTotais(tx, alvo);
    const regs = diferencas(alvo === id ? base : base, e);
    if (alvo !== id) regs.unshift({ acao: 'NOVA_VERSAO', descricao: `Nova versão criada a partir da v${base!.c.versao}. ${motivo}` });
    if (e.atualizarPrecos && recalculados) regs.push({ acao: 'PRECOS_ATUALIZADOS', descricao: 'Preços atualizados pelo catálogo vigente.' });
    if (e.offline) regs.push({ acao: 'SINCRONIZADO', descricao: 'Alterações feitas sem internet foram sincronizadas e recalculadas.' });
    await auditar(tx, alvo, u.id, regs, e.offline);

    if (e.vendaTotalLocal != null && !d(e.vendaTotalLocal).eq(t.total)) {
      avisos.push(`O valor calculado no aparelho (R$ ${d(e.vendaTotalLocal).toFixed(2)}) mudou para R$ ${t.total.toFixed(2)} com o catálogo atual.`);
    }
    return { id: alvo, novaVersao: alvo !== id, motivoNovaVersao: motivo, repetido: false, avisos };
  });
}

/** Nova versão a pedido do vendedor (ex.: depois da medição). Mantém o snapshot, salvo `atualizarPrecos`. */
export async function novaVersao(db: Banco, u: UsuarioSessao, id: string, atualizarPrecos: boolean) {
  const doc = await lerDocumento(db, id);
  if (!doc || !noEscopo(u, doc.c)) throw new ErroOrcamento('Orçamento não encontrado.', 404);
  const ultimo = (await lerCabecalho(db, doc.c.versaoMaisNovaId))!;
  if (ESTADOS_FINAIS.has(ultimo.status) && ultimo.status !== 'EXPIRADO') throw new ErroOrcamento('Orçamento encerrado: não gera nova versão.', 409);
  if (ultimo.status === 'RASCUNHO') throw new ErroOrcamento(`A v${ultimo.versao} ainda é rascunho: edite-a direto.`, 409, { id: ultimo.id });
  const novoId = await db.transaction(async (tx) => {
    const nid = await criarVersao(tx, ultimo, u, true);
    await tx.execute(sql`UPDATE orcamentos SET atualizado_em = date_trunc('milliseconds', clock_timestamp()),
      validade_ate = CURRENT_DATE + COALESCE((SELECT valor::int FROM parametros_sistema WHERE chave = 'VALIDADE_ORCAMENTO_DIAS'
        AND loja_id = ${u.lojaId} ORDER BY vigente_desde DESC LIMIT 1), 15) WHERE id = ${nid}`);
    await recalcularTotais(tx, nid);
    await auditar(tx, nid, u.id, [{ acao: 'NOVA_VERSAO', descricao: `Nova versão criada a partir da v${ultimo.versao}.` }]);
    return nid;
  });
  if (atualizarPrecos) {
    const d2 = (await lerDocumento(db, novoId))!;
    await salvarDocumento(db, u, novoId, {
      clienteId: d2.c.clienteId, titulo: d2.c.titulo, atualizarPrecos: true, offline: false,
      condicoes: documentoPublico(u, d2).condicoes as DocumentoEntrada['condicoes'],
      itens: d2.itens.map((i) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, descricaoComercial: i.descricaoComercial, entrada: i.entrada, ajustes: i.ajustes }) as ItemDocumento),
    });
  }
  return novoId;
}

/** Mudança de status. Enviar congela a versão e exige a liberação quando a trava pede. */
export async function mudarStatus(db: Banco, u: UsuarioSessao, id: string, status: string, motivoPerda?: string) {
  const c = await lerCabecalho(db, id);
  if (!c || !noEscopo(u, c)) throw new ErroOrcamento('Orçamento não encontrado.', 404);
  if (c.versaoMaisNovaId !== c.id) throw new ErroOrcamento(`Use a versão mais nova (v${c.versaoMaisNova}).`, 409);
  if (ehRascunhoAditivo(c)) throw new ErroOrcamento(`Este rascunho é um aditivo do pedido ${c.pedidoNumero ?? ''}: confirme ou descarte no pedido.`, 409);
  if (!(TRANSICOES[c.status] ?? []).includes(status)) throw new ErroOrcamento(`Não é possível passar de ${c.status} para ${status}.`, 409);
  if (status === 'PERDIDO' && !motivoPerda) throw new ErroOrcamento('Informe o motivo da perda.');
  await db.transaction(async (tx) => {
    if (status === 'ENVIADO') {
      const [n] = await linhas<{ n: number }>(tx, sql`SELECT COUNT(*)::int AS n FROM orcamento_itens_compostos WHERE orcamento_id = ${id}`);
      if (!n?.n) throw new ErroOrcamento('Inclua ao menos um item antes de enviar.');
      const lib = situacaoLiberacao(c);
      if (lib.pendente) {
        if (u.perfil !== 'ADMIN') throw new ErroOrcamento('Precisa da senha do administrador para enviar.', 409, { exigeLiberacao: true, motivos: lib.motivos });
        await registrarLiberacao(tx, c, u.id, u.id);
      }
      await tx.execute(sql`UPDATE orcamentos SET status = 'ENVIADO', enviado_em = NOW(), congelado_em = NOW(),
        validade_ate = COALESCE(validade_ate, CURRENT_DATE + 15), atualizado_em = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${id}`);
    } else {
      await tx.execute(sql`UPDATE orcamentos SET status = ${status}::status_orcamento_enum,
        motivo_perda = ${status === 'PERDIDO' ? motivoPerda!.slice(0, 120) : null},
        congelado_em = COALESCE(congelado_em, NOW()), atualizado_em = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${id}`);
    }
    const nomes: Record<string, string> = { ENVIADO: 'Enviado ao cliente (versão congelada)', AGUARDANDO_MEDICAO: 'Aguardando medição',
      EM_NEGOCIACAO: 'Em negociação', PERDIDO: `Perdido: ${motivoPerda ?? ''}` };
    await auditar(tx, id, u.id, [{ acao: 'STATUS', descricao: `${nomes[status] ?? status}.`, detalhes: { de: c.status, para: status } }]);
  });
}

async function registrarLiberacao(tx: Exec, c: Cabecalho, adminId: string, quemPediu: string) {
  await tx.execute(sql`UPDATE orcamentos SET liberado_por_id = ${adminId}, liberado_em = NOW(),
    liberado_margem_pct = margem_prevista_pct, liberado_desconto_pct = desconto_percentual WHERE id = ${c.id}`);
  await auditar(tx, c.id, quemPediu, [{
    acao: 'LIBERACAO_MARGEM',
    descricao: `Liberado pelo administrador: margem ${d(c.margemLiquidaPct).toFixed(2)}%, desconto ${d(c.descontoPct).toFixed(2)}%.`,
    detalhes: { adminId, margem: c.margemLiquidaPct, desconto: c.descontoPct },
  }]);
}

export async function liberar(db: Banco, u: UsuarioSessao, id: string, adminId: string) {
  const c = await lerCabecalho(db, id);
  if (!c || !noEscopo(u, c)) throw new ErroOrcamento('Orçamento não encontrado.', 404);
  await registrarLiberacao(db, c, adminId, u.id);
}
