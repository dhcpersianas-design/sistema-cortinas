'use client';
/**
 * Orçamentos no aparelho (offline na obra, especificação v1.1 seção 12.5).
 * - O orçamento é gravado inteiro (PUT /api/orcamentos/:id). Sem internet, fica no
 *   IndexedDB marcado como `pendente` e é enviado quando a conexão volta.
 * - O cálculo no aparelho usa o MESMO motor da API (@sistema/motor-calculo/navegador) com o
 *   catálogo em cache. É provisório: o servidor recalcula, rateia e confere a margem.
 * - Conflito (editado em dois lugares) não sobrescreve: o servidor grava como nova versão.
 */
import {
  aplicarPrecosBarra, calcularItem, criarCatalogo, descricaoComercial, totalizarOrcamento,
  type Ajuste, type Catalogo, type EntradaItem, type LinhaPrecoBarra, type Produto,
} from '@sistema/motor-calculo/navegador';
import { apagar, gravar, ler, todos } from './offline-db';

// ------------------------------------------------------------------ tipos (espelham a API)

export type Componente = {
  id?: string; sku: string; descricao: string; unidade: string;
  quantidadeCalculada: string | null; quantidadeOverride: string | null; quantidade: string; formulaLog: string | null;
  precoUnitario: string; precoTotal: string; custoUnitario?: string; custoTotal?: string;
  descontoRateado?: string; precoTotalLiquido?: string; origem: 'MOTOR' | 'MANUAL';
};
export type Alerta = { codigo: string; severidade: string; mensagem: string; skuSugerido?: string };
export type Item = {
  id: string; ambiente: string; tipo: 'CORTINA' | 'PERSIANA'; descricaoComercial: string;
  entrada: Record<string, unknown>; ajustes: Ajuste[];
  larguraProducao?: string; alturaProducao?: string;
  vendaTotal?: string; custoTotal?: string; descontoRateado?: string; vendaLiquida?: string;
  alertas?: Alerta[]; componentes?: Componente[];
};
export type Condicoes = {
  descontoTipo: 'PERCENTUAL' | 'VALOR'; descontoValor: string; acrescimo: string;
  formaPagamento: string | null; parcelas: number; validadeAte: string | null;
  prazoEntregaDias: number | null; garantiaTexto: string | null; condicoesPagamentoTexto: string | null;
  observacoesCliente: string | null; observacoesInternas: string | null; medidasConferidas: boolean;
};
export type Totais = {
  subtotal: string; descontoValor: string; descontoPct: string; acrescimo: string; total: string; semaforo: string;
  custoTotal?: string; lucroBruto?: string; margemBrutaPct?: string; taxaPagamentoPct?: string; taxaPagamento?: string;
  imposto?: string; comissaoPct?: string; comissao?: string; lucroLiquido?: string; margemLiquidaPct?: string;
};
export type Orcamento = {
  id: string; grupoId?: string; codigo?: string; versao?: number; origemId?: string | null; status: string; titulo: string | null;
  clienteId: string; clienteNome: string; clienteTelefone?: string; vendedorNome?: string;
  atualizadoEm: string | null; enviadoEm?: string | null; congeladoEm?: string | null; motivoPerda?: string | null;
  editavel: boolean; versaoMaisNovaId?: string; versaoMaisNova?: number; podeVerCustos?: boolean;
  /** Pedido do projeto (depois de aprovado) e se este rascunho é um aditivo do pedido. */
  pedidoId?: string | null; pedidoNumero?: string | null; aditivo?: boolean;
  condicoes: Condicoes; itens: Item[]; totais?: Totais;
  liberacao?: { exige: boolean; motivos: string[]; liberado: boolean; pendente: boolean; liberadoPorNome: string | null; liberadoEm: string | null };
  /** Só no aparelho */
  pendente?: boolean; idOperacao?: string; provisorio?: boolean; erroSync?: string | null;
};

export class ErroApi extends Error {
  constructor(message: string, public status: number, public dados: Record<string, unknown>) { super(message); }
}
const semRede = (e: unknown) => !(e instanceof ErroApi);

export async function chamar<T>(caminho: string, method = 'GET', corpo?: unknown): Promise<T> {
  const r = await fetch(caminho, {
    method, credentials: 'same-origin',
    headers: corpo !== undefined ? { 'content-type': 'application/json' } : {},
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi((dados as { erro?: string }).erro ?? `Erro ${r.status}`, r.status, dados);
  return dados as T;
}

export const CONDICOES_PADRAO: Condicoes = {
  descontoTipo: 'PERCENTUAL', descontoValor: '0', acrescimo: '0', formaPagamento: null, parcelas: 1, validadeAte: null,
  prazoEntregaDias: null, garantiaTexto: null, condicoesPagamentoTexto: null, observacoesCliente: null, observacoesInternas: null,
  medidasConferidas: false,
};

// ------------------------------------------------------------------ catálogo e cálculo no aparelho

export type ProdutoCatalogo = {
  id: string; sku: string; nome: string; categoria: string; categoriaId: number; unidade: string;
  precoVendaUnitario: string; custoUnitario?: string; metadata: Record<string, unknown>;
  barras: { tamanhoM: number; venda: string; custo?: string }[]; tabelaBarrasCompleta: boolean;
};

let catalogoCache: { produtos: ProdutoCatalogo[]; catalogo: Catalogo } | null = null;

/** Catálogo para o cálculo. Com internet vem da API (o service worker guarda cópia); sem, do aparelho. */
export async function carregarCatalogo(): Promise<{ produtos: ProdutoCatalogo[]; catalogo: Catalogo }> {
  let produtos: ProdutoCatalogo[];
  try {
    produtos = (await chamar<{ produtos: ProdutoCatalogo[] }>('/api/catalogo/produtos')).produtos;
    await gravar('meta', produtos, 'catalogo');
  } catch (e) {
    if (!semRede(e) && (e as ErroApi).status !== 503) throw e;
    if (catalogoCache) return catalogoCache;
    produtos = (await ler<ProdutoCatalogo[]>('meta', 'catalogo')) ?? [];
  }
  // Quem não vê custo calcula com custo 0: no aparelho só o preço de venda vale.
  const base: Produto[] = produtos.map((p) => ({
    sku: p.sku, nome: p.nome, unidade: p.unidade as Produto['unidade'],
    custoUnitario: p.custoUnitario ?? '0', precoVendaUnitario: p.precoVendaUnitario, metadata: p.metadata,
  }));
  const linhas: LinhaPrecoBarra[] = produtos.flatMap((p) => p.barras.map((b) => ({ sku: p.sku, tamanhoM: String(b.tamanhoM), custo: b.custo ?? '0', venda: b.venda })));
  catalogoCache = { produtos, catalogo: criarCatalogo(aplicarPrecosBarra(base, linhas).produtos) };
  return catalogoCache;
}

/** Recalcula no aparelho (provisório). Lança erro do motor se a entrada é inválida. */
export function calcularLocal(o: Orcamento, catalogo: Catalogo, verCusto: boolean): Orcamento {
  const itens = o.itens.map((i) => {
    const e = { tipo: i.tipo, entrada: i.entrada } as unknown as EntradaItem;
    const r = calcularItem(e, i.ajustes, catalogo);
    return {
      ...i,
      descricaoComercial: i.descricaoComercial || descricaoComercial(e, catalogo),
      larguraProducao: r.larguraProducao.toFixed(4), alturaProducao: r.alturaProducao.toFixed(4),
      vendaTotal: r.vendaTotal.toFixed(2), custoTotal: verCusto ? r.custoTotal.toFixed(2) : undefined,
      alertas: r.alertas,
      componentes: r.componentes.map((c) => ({
        sku: c.sku, descricao: c.descricao, unidade: c.unidade,
        quantidadeCalculada: c.quantidadeCalculada?.toFixed(4) ?? null, quantidadeOverride: c.quantidadeOverride?.toFixed(4) ?? null,
        quantidade: c.quantidade.toFixed(4), formulaLog: c.formulaLog, precoUnitario: c.precoUnitario.toFixed(4), precoTotal: c.precoTotal.toFixed(2),
        ...(verCusto ? { custoUnitario: c.custoUnitario.toFixed(4), custoTotal: c.custoTotal.toFixed(2) } : {}),
        origem: c.origem,
      })),
    };
  });
  const t = totalizarOrcamento(itens.map((i) => ({ vendaTotal: i.vendaTotal!, custoTotal: i.custoTotal ?? '0' })), {
    descontoTipo: o.condicoes.descontoTipo, descontoValor: o.condicoes.descontoValor || '0', acrescimo: o.condicoes.acrescimo || '0',
  });
  return {
    ...o, itens, provisorio: true,
    totais: {
      subtotal: t.subtotal.toFixed(2), descontoValor: t.descontoValor.toFixed(2), descontoPct: t.descontoPct.toFixed(2),
      acrescimo: t.acrescimo.toFixed(2), total: t.total.toFixed(2), semaforo: verCusto ? t.semaforo : 'PENDENTE',
      ...(verCusto ? { custoTotal: t.custoTotal.toFixed(2), margemLiquidaPct: t.margemLiquidaPct.toFixed(2) } : {}),
    },
  };
}

// ------------------------------------------------------------------ gravação e sincronização

function corpoDe(o: Orcamento, extra: { offline?: boolean; atualizarPrecos?: boolean } = {}) {
  return {
    idOperacao: o.idOperacao ?? crypto.randomUUID(),
    atualizadoEmBase: o.atualizadoEm,
    clienteId: o.clienteId, titulo: o.titulo,
    // Orçamento novo: prazo em branco = o servidor usa o padrão da loja.
    condicoes: o.atualizadoEm == null && o.condicoes.prazoEntregaDias == null
      ? { ...o.condicoes, prazoEntregaDias: undefined } : o.condicoes,
    itens: o.itens.map((i) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, descricaoComercial: i.descricaoComercial || undefined, entrada: i.entrada, ajustes: i.ajustes })),
    vendaTotalLocal: o.provisorio ? o.totais?.total : undefined,
    ...extra,
  };
}

export type ResultadoGravar = {
  orcamento: Orcamento; offline: boolean; avisos: string[]; novaVersao?: boolean; idAnterior?: string;
};

type RespostaPut = { orcamento: Orcamento; novaVersao: boolean; avisos: string[] };

/** Grava no servidor; sem internet guarda no aparelho para enviar depois. */
export async function gravarOrcamento(o: Orcamento, opcoes: { atualizarPrecos?: boolean } = {}): Promise<ResultadoGravar> {
  const corpo = corpoDe(o, opcoes);
  try {
    const r = await chamar<RespostaPut>(`/api/orcamentos/${o.id}`, 'PUT', corpo);
    if (r.novaVersao) await apagar('orcamentos', o.id);
    await gravar('orcamentos', r.orcamento);
    return { orcamento: r.orcamento, offline: false, avisos: r.avisos, novaVersao: r.novaVersao, idAnterior: o.id };
  } catch (e) {
    if (!semRede(e)) throw e;
    const local: Orcamento = { ...o, pendente: true, idOperacao: corpo.idOperacao, erroSync: null };
    await gravar('orcamentos', local);
    return { orcamento: local, offline: true, avisos: ['Sem internet: guardado no aparelho. Será enviado e recalculado quando a conexão voltar.'] };
  }
}

export type ResultadoEnvio = { enviados: number; recusados: string[]; avisos: string[]; pendentes: number; trocas: [string, string][] };
let enviando: Promise<ResultadoEnvio> | null = null;

/** Envia os orçamentos pendentes (cada um com o mesmo idOperacao: reenviar não duplica). */
export function enviarPendentes(): Promise<ResultadoEnvio> {
  if (enviando) return enviando;
  enviando = (async () => {
    const pend = (await todos<Orcamento>('orcamentos')).filter((o) => o.pendente);
    const res: ResultadoEnvio = { enviados: 0, recusados: [], avisos: [], pendentes: 0, trocas: [] };
    for (const o of pend) {
      try {
        const r = await chamar<RespostaPut>(`/api/orcamentos/${o.id}`, 'PUT', corpoDe(o, { offline: true }));
        if (r.orcamento.id !== o.id) { await apagar('orcamentos', o.id); res.trocas.push([o.id, r.orcamento.id]); }
        await gravar('orcamentos', r.orcamento);
        res.avisos.push(...r.avisos.map((a) => `${r.orcamento.codigo}: ${a}`));
        res.enviados++;
      } catch (e) {
        if (semRede(e)) break;
        // Recusado (ex.: medida inválida): continua no aparelho para o vendedor corrigir.
        await gravar('orcamentos', { ...o, erroSync: (e as Error).message });
        res.recusados.push(`${o.codigo ?? o.clienteNome}: ${(e as Error).message}`);
      }
    }
    res.pendentes = (await todos<Orcamento>('orcamentos')).filter((o) => o.pendente).length;
    return res;
  })().finally(() => { enviando = null; });
  return enviando;
}

export async function contarPendentes(): Promise<number> {
  return (await todos<Orcamento>('orcamentos')).filter((o) => o.pendente).length;
}

/** Baixa os orçamentos abertos do vendedor (não mexe nos pendentes do aparelho). */
export async function baixarPacote(): Promise<void> {
  const p = await chamar<{ orcamentos: Orcamento[]; parametros: unknown }>('/api/orcamentos/pacote-offline');
  const locais = new Map((await todos<Orcamento>('orcamentos')).map((o) => [o.id, o]));
  for (const o of p.orcamentos) { if (!locais.get(o.id)?.pendente) await gravar('orcamentos', o); }
  await gravar('meta', p.parametros, 'parametrosOrcamento');
  await gravar('meta', new Date().toISOString(), 'orcamentosBaixadosEm');
}

export async function abrirOrcamento(id: string): Promise<{ orcamento: Orcamento; transicoes: string[]; podeAprovar?: boolean; offline: boolean } | null> {
  const local = await ler<Orcamento>('orcamentos', id);
  if (local?.pendente) return { orcamento: local, transicoes: [], offline: false };
  try {
    const r = await chamar<{ orcamento: Orcamento; transicoes: string[]; podeAprovar?: boolean }>(`/api/orcamentos/${id}`);
    await gravar('orcamentos', r.orcamento);
    return { ...r, offline: false };
  } catch (e) {
    if (!semRede(e)) { if ((e as ErroApi).status === 404) return null; throw e; }
    return local ? { orcamento: local, transicoes: [], offline: true } : null;
  }
}

export type ResumoLista = {
  id: string; codigo: string | null; versao: number | null; status: string; titulo: string | null; clienteNome: string;
  vendedorNome?: string; total: string | null; semaforo: string | null; atualizadoEm: string | null; qtdItens: number; pendente?: boolean;
};

export async function listar(q: string, status: string): Promise<{ orcamentos: ResumoLista[]; offline: boolean }> {
  const locais = (await todos<Orcamento>('orcamentos'));
  const resumo = (o: Orcamento): ResumoLista => ({
    id: o.id, codigo: o.codigo ?? null, versao: o.versao ?? null, status: o.status, titulo: o.titulo, clienteNome: o.clienteNome,
    total: o.totais?.total ?? null, semaforo: o.totais?.semaforo ?? null, atualizadoEm: o.atualizadoEm, qtdItens: o.itens.length, pendente: o.pendente,
  });
  try {
    const p = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) });
    const { orcamentos } = await chamar<{ orcamentos: ResumoLista[] }>(`/api/orcamentos?${p}`);
    const pend = locais.filter((o) => o.pendente && !orcamentos.some((x) => x.id === o.id)).map(resumo);
    return { orcamentos: [...pend, ...orcamentos.map((o) => ({ ...o, pendente: locais.find((l) => l.id === o.id)?.pendente }))], offline: false };
  } catch (e) {
    if (!semRede(e)) throw e;
    const termo = q.toLowerCase();
    // Só a versão mais nova de cada projeto
    const porGrupo = new Map<string, Orcamento>();
    for (const o of locais) {
      const g = o.grupoId ?? o.id;
      const a = porGrupo.get(g);
      if (!a || (o.versao ?? 0) > (a.versao ?? 0)) porGrupo.set(g, o);
    }
    const filtrados = [...porGrupo.values()].filter((o) => (!status || o.status === status)
      && (!termo || `${o.clienteNome} ${o.codigo ?? ''} ${o.titulo ?? ''}`.toLowerCase().includes(termo)));
    return { orcamentos: filtrados.map(resumo), offline: true };
  }
}
