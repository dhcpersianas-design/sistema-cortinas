/**
 * Regras por LINHA de persiana vindas das tabelas dos fornecedores (Gabriel, 27/11/2026).
 * Tudo fica na `metadata_tecnica` do produto; nada aqui vai para o PDF do cliente,
 * exceto o texto `descricao` de um adicional escolhido (ex.: "cascata").
 *
 * Chaves novas da metadata (todas opcionais):
 *  - larg_min_producao       abaixo disso a fábrica não produz (alerta crítico)
 *  - area_max                m² máximo recomendado por peça (acima = sob consulta)
 *  - larg_max_consulta / alt_max_consulta
 *                            com estas chaves, passar de larg_max/alt_max vira "sob consulta"
 *                            (atenção) e só passar destas vira crítico
 *  - sem_garantia_larg_acima largura acima da qual a peça fica sem garantia
 *  - prazo_fabrica_dias      prazo de entrega da fábrica (dias úteis), informativo
 *  - acionamentos            modelos de acionamento aceitos (D, E, B, C, SPT, DUPLEX, H, EL, DE, DD, ED)
 *  - avisos                  textos curtos para o quadro do vendedor
 *  - adicionais              opcionais com acréscimo (% ou R$ de custo por m², metro ou peça)
 *  - limites_por_opcao       limites que mudam com MOTORIZADO ou com um adicional (ex.: cascata)
 *  - motor_incluso           motorização própria da linha (ex.: Magic): não soma motor/controle avulsos
 *  - skus                    peças da linha (bandô, guia lateral...) no lugar das peças padrão
 *  - bandos                  SKUs de bandô/sanefa que o vendedor pode escolher (opcional vendido à parte; 1º = padrão)
 *  - rotulo_bando            nome da peça na tela e no PDF ("Sanefa" na vertical; padrão "Bandô")
 *  - bando_incluso           a linha já vem com o bandô (ex.: Caixa Box): não mostra nem soma bandô avulso
 */
import { Decimal, d, dinheiro, ErroEntrada, unitario } from './decimal.js';
import type { ComponenteCalculado, Produto } from './tipos.js';

export type TipoAdicional = 'PCT' | 'CUSTO_M2' | 'CUSTO_ML' | 'CUSTO_PECA';

export interface AdicionalModelo {
  codigo: string;
  rotulo: string;
  tipo: TipoAdicional;
  /** PCT: 15 = +15% (negativo = desconto). Demais: valor de CUSTO em R$ (a venda segue o markup do produto). */
  valor: number;
  /** Entra sozinho quando a condição vale (o vendedor não precisa marcar). */
  automatico?: { larg_menor_que?: number; motorizado?: boolean };
  /** Avisa o vendedor para marcar quando a área da peça passar disto (m²). */
  sugerir_area_acima?: number;
  /** Texto que vai na descrição do item para o cliente (ex.: "cascata"). Sem ele, fica só interno. */
  descricao?: string;
}

export interface LimitesModelo {
  larg_min_producao?: number;
  larg_max?: number;
  alt_max?: number;
  area_max?: number;
  larg_max_consulta?: number;
  alt_max_consulta?: number;
}

/** Modelos de acionamento das tabelas de fornecedor (desenhos "Tipos de acionamento"). */
export const MODELOS_ACIONAMENTO: Record<string, string> = {
  D: 'Modelo D: comando do lado direito',
  E: 'Modelo E: comando do lado esquerdo',
  B: 'Modelo B: freio à esquerda, giro à direita',
  C: 'Modelo C: giro à esquerda, freio à direita',
  SPT: 'Modelo SPT: suporte intermediário (2 rolos num só conjunto)',
  DUPLEX: 'Modelo DUPLEX: cabeçote único, comandos à esquerda e à direita',
  H: 'Modelo H: comando de um lado, lâminas no centro',
  EL: 'Modelo EL: comando à esquerda, lâminas à direita',
  ED: 'Modelo ED: comando à direita, lâminas à esquerda',
  DE: 'Modelo DE: abertura central, comando à esquerda',
  DD: 'Modelo DD: abertura central, comando à direita',
};

const numero = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function adicionaisDoModelo(p: Pick<Produto, 'metadata'> | undefined): AdicionalModelo[] {
  const lista = p?.metadata?.['adicionais'];
  if (!Array.isArray(lista)) return [];
  return lista.filter((a): a is AdicionalModelo =>
    !!a && typeof a === 'object' && typeof (a as AdicionalModelo).codigo === 'string' && Number.isFinite(Number((a as AdicionalModelo).valor)));
}

export function acionamentosDoModelo(p: Pick<Produto, 'metadata'> | undefined): string[] {
  const lista = p?.metadata?.['acionamentos'];
  return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === 'string') : [];
}

export function avisosDoModelo(p: Pick<Produto, 'metadata'> | undefined): string[] {
  const lista = p?.metadata?.['avisos'];
  return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** Limites valendo para a escolha: base da metadata, depois MOTORIZADO, depois cada adicional escolhido. */
export function limitesDoModelo(p: Pick<Produto, 'metadata'>, motorizado: boolean, adicionais: string[]): LimitesModelo {
  const m = p.metadata ?? {};
  const chaves: (keyof LimitesModelo)[] = ['larg_min_producao', 'larg_max', 'alt_max', 'area_max', 'larg_max_consulta', 'alt_max_consulta'];
  const out: LimitesModelo = {};
  for (const k of chaves) { const v = numero(m[k]); if (v !== undefined) out[k] = v; }
  const porOpcao = (m['limites_por_opcao'] ?? {}) as Record<string, Partial<Record<keyof LimitesModelo, unknown>>>;
  const aplicar = (chave: string) => {
    const o = porOpcao[chave];
    if (!o || typeof o !== 'object') return;
    for (const k of chaves) { const v = numero(o[k]); if (v !== undefined) out[k] = v; }
  };
  if (motorizado) aplicar('MOTORIZADO');
  for (const a of adicionais) aplicar(a);
  return out;
}

/** Adicionais que valem no item: os marcados pelo vendedor + os automáticos cuja condição vale. */
export function adicionaisAplicados(
  p: Produto,
  escolhidos: string[] | undefined,
  ctx: { larguraPeca: Decimal; motorizado: boolean },
): AdicionalModelo[] {
  const todos = adicionaisDoModelo(p);
  const marcados = new Set(escolhidos ?? []);
  for (const c of marcados) {
    if (!todos.some((a) => a.codigo === c)) throw new ErroEntrada(`Opcional "${c}" não existe para ${p.nome}.`);
  }
  return todos.filter((a) => {
    if (marcados.has(a.codigo)) return true;
    const auto = a.automatico;
    if (!auto) return false;
    if (auto.motorizado) return ctx.motorizado;
    if (auto.larg_menor_que !== undefined) return ctx.larguraPeca.lt(auto.larg_menor_que);
    return false;
  });
}

const br = (x: Decimal | number) => d(x).toFixed(2).replace('.', ',');

export function textoAdicional(a: AdicionalModelo): string {
  const v = Number(a.valor);
  if (a.tipo === 'PCT') return `${a.rotulo} (${v >= 0 ? '+' : ''}${br(v).replace(',00', '')}%)`;
  const un = a.tipo === 'CUSTO_M2' ? 'm²' : a.tipo === 'CUSTO_ML' ? 'metro de largura' : 'peça';
  return `${a.rotulo} (+R$ ${br(v)} de custo por ${un})`;
}

/**
 * Soma os adicionais na linha do produto principal (mesmo SKU, para não quebrar ajustes e pedidos):
 *  - % somam entre si e valem sobre o custo e a venda da tabela;
 *  - R$ por m² entram no unitário; R$ por metro de largura e por peça entram no total da linha.
 * Valores em R$ são de CUSTO; a venda usa a mesma proporção venda/custo do produto (o markup).
 */
export function somarAdicionais(
  base: ComponenteCalculado,
  produto: Produto,
  adicionais: AdicionalModelo[],
  ctx: { larguraPeca: Decimal; numPecas: number },
): ComponenteCalculado {
  if (adicionais.length === 0) return base;
  const custoTab = d(produto.custoUnitario);
  const vendaTab = d(produto.precoVendaUnitario);
  const fatorVenda = custoTab.gt(0) ? vendaTab.div(custoTab) : new Decimal(1);
  let pct = new Decimal(0);
  let porM2 = new Decimal(0);
  let fixo = new Decimal(0);
  for (const a of adicionais) {
    const v = d(a.valor);
    if (a.tipo === 'PCT') pct = pct.plus(v);
    else if (a.tipo === 'CUSTO_M2') porM2 = porM2.plus(v);
    else if (a.tipo === 'CUSTO_ML') fixo = fixo.plus(v.mul(ctx.larguraPeca).mul(ctx.numPecas));
    else fixo = fixo.plus(v.mul(ctx.numPecas));
  }
  const q = base.quantidade;
  const mult = pct.div(100).plus(1);
  const custoTotal = dinheiro(q.mul(custoTab.mul(mult).plus(porM2)).plus(fixo));
  const precoTotal = dinheiro(q.mul(vendaTab.mul(mult).plus(porM2.mul(fatorVenda))).plus(fixo.mul(fatorVenda)));
  return {
    ...base,
    custoUnitario: q.gt(0) ? unitario(custoTotal.div(q)) : base.custoUnitario,
    precoUnitario: q.gt(0) ? unitario(precoTotal.div(q)) : base.precoUnitario,
    custoTotal,
    precoTotal,
    formulaLog: `${base.formulaLog}; adicionais: ${adicionais.map(textoAdicional).join(', ')}`,
  };
}

/** Bandô/sanefa vendido à parte: SKUs que o vendedor pode escolher (o 1º é o padrão). */
export function bandosDoModelo(p: Pick<Produto, 'metadata'> | undefined): string[] {
  const b = p?.metadata?.['bandos'];
  return Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/** "Sanefa" na vertical; "Bandô" nas demais. */
export function rotuloBando(p: Pick<Produto, 'metadata'> | undefined): string {
  const r = p?.metadata?.['rotulo_bando'];
  return typeof r === 'string' && r ? r : 'Bandô';
}

/** A linha já vem com o bandô (ex.: Caixa Box). */
export function bandoIncluso(p: Pick<Produto, 'metadata'> | undefined): boolean {
  return p?.metadata?.['bando_incluso'] === true;
}
