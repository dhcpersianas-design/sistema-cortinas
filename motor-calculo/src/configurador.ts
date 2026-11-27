/**
 * Configurador de orçamento (especificação v1.1, seções 1, 3 e 11.1).
 * Funções puras, usadas pela API (oficial) e pelo app offline (provisório):
 *  - calcularItem: explode o item pelo motor e aplica os ajustes manuais do vendedor
 *    (trocar, incluir, remover componente ou mudar quantidade), na ordem em que foram feitos.
 *  - totalizarOrcamento: desconto (% ou R$), rateio proporcional ao valor de venda,
 *    taxa de pagamento, imposto e comissão -> margem LÍQUIDA e semáforo 45/35.
 *  - descricaoComercial: o texto limpo que vai para o PDF do cliente.
 */
import { Decimal, d, dinheiro, ErroEntrada, ZERO, type Numerico } from './decimal.js';
import { componente, margemPct } from './comum.js';
import { calcularCortina, type EntradaCortina } from './cortina.js';
import { calcularPersiana, medidaProducao, type EntradaPersiana } from './persiana.js';
import { semaforoMargem, LIMITES_SEMAFORO_PADRAO, type CorSemaforo, type LimitesSemaforo } from './precificacao.js';
import type { Alerta, Catalogo, ComponenteCalculado, Produto, ResultadoCalculo } from './tipos.js';

export type EntradaItem =
  | { tipo: 'CORTINA'; entrada: EntradaCortina }
  | { tipo: 'PERSIANA'; entrada: EntradaPersiana };

/** Ajuste manual sobre a explosão do motor (regra de ouro 3: com auditoria). */
export type Ajuste =
  | { tipo: 'QUANTIDADE'; sku: string; quantidade: Numerico; motivo?: string }
  | { tipo: 'REMOVER'; sku: string; motivo?: string }
  | { tipo: 'ADICIONAR'; sku: string; quantidade: Numerico; motivo?: string }
  | { tipo: 'SUBSTITUIR'; sku: string; novoSku: string; motivo?: string };

export interface ComponenteItem extends ComponenteCalculado {
  /** Quantidade que o motor calculou (null quando o componente foi incluído à mão). */
  quantidadeCalculada: Decimal | null;
  /** Quantidade digitada pelo vendedor (null = vale a do motor). */
  quantidadeOverride: Decimal | null;
  origem: 'MOTOR' | 'MANUAL';
}

export interface ResultadoItem {
  tipo: 'CORTINA' | 'PERSIANA';
  componentes: ComponenteItem[];
  custoTotal: Decimal;
  vendaTotal: Decimal;
  alertas: Alerta[];
  especificacaoTecnica: Record<string, unknown>;
  larguraProducao: Decimal;
  alturaProducao: Decimal;
  larguraBruta: Decimal | null;
  alturaBruta: Decimal | null;
  /** O motor puro, antes dos ajustes. */
  motor: ResultadoCalculo;
}

const QTD_INTEIRA = new Set(['UN', 'PC']);

function quantidadeValida(sku: string, unidade: string, q: Numerico): Decimal {
  const v = d(q);
  if (v.lte(0)) throw new ErroEntrada(`Quantidade de ${sku} deve ser maior que zero (para tirar o componente, use remover).`);
  if (QTD_INTEIRA.has(unidade) && !v.isInteger()) throw new ErroEntrada(`${sku} é vendido em ${unidade}: use quantidade inteira.`);
  return v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/** Recalcula a linha com a nova quantidade (mesmos unitários do snapshot). */
function comQuantidade(c: ComponenteItem, q: Decimal, override: boolean): ComponenteItem {
  return {
    ...c,
    quantidade: q,
    quantidadeOverride: override ? q : null,
    custoTotal: dinheiro(q.mul(c.custoUnitario)),
    precoTotal: dinheiro(q.mul(c.precoUnitario)),
  };
}

export function aplicarAjustes(base: ComponenteCalculado[], ajustes: Ajuste[], catalogo: Catalogo): ComponenteItem[] {
  let lista: ComponenteItem[] = base.map((c) => ({ ...c, quantidadeCalculada: c.quantidade, quantidadeOverride: null, origem: 'MOTOR' }));
  const achar = (sku: string) => {
    const i = lista.findIndex((c) => c.sku === sku);
    if (i < 0) throw new ErroEntrada(`Ajuste manual: o componente ${sku} não está mais neste item. Refaça o ajuste.`);
    return i;
  };
  for (const a of ajustes) {
    if (a.tipo === 'QUANTIDADE') {
      const i = achar(a.sku);
      const c = lista[i]!;
      lista[i] = comQuantidade(c, quantidadeValida(a.sku, c.unidade, a.quantidade), true);
    } else if (a.tipo === 'REMOVER') {
      lista.splice(achar(a.sku), 1);
    } else if (a.tipo === 'ADICIONAR') {
      if (lista.some((c) => c.sku === a.sku)) throw new ErroEntrada(`${a.sku} já está no item: altere a quantidade em vez de incluir de novo.`);
      const p = catalogo.obter(a.sku);
      const q = quantidadeValida(a.sku, p.unidade, a.quantidade);
      lista.push({ ...componente(p, q, `incluído manualmente: ${q.toString()} ${p.unidade}`), quantidadeCalculada: null, quantidadeOverride: q, origem: 'MANUAL' });
    } else if (a.tipo === 'SUBSTITUIR') {
      const i = achar(a.sku);
      const c = lista[i]!;
      if (a.novoSku === a.sku) continue;
      if (lista.some((x) => x.sku === a.novoSku)) throw new ErroEntrada(`${a.novoSku} já está no item.`);
      const p = catalogo.obter(a.novoSku);
      if (p.unidade !== c.unidade) throw new ErroEntrada(`Troca de ${a.sku} (${c.unidade}) por ${a.novoSku} (${p.unidade}): a unidade precisa ser a mesma.`);
      const novo = componente(p, c.quantidade, `${c.formulaLog} | trocado de ${a.sku}`);
      lista[i] = { ...novo, quantidadeCalculada: c.quantidadeCalculada, quantidadeOverride: c.quantidadeOverride, origem: 'MANUAL' };
    } else {
      throw new ErroEntrada('Tipo de ajuste desconhecido.');
    }
  }
  return lista;
}

/** Explode o item pelo motor e aplica os ajustes manuais. */
export function calcularItem(item: EntradaItem, ajustes: Ajuste[], catalogo: Catalogo): ResultadoItem {
  let motor: ResultadoCalculo;
  let larguraProducao: Decimal, alturaProducao: Decimal;
  let larguraBruta: Decimal | null = null, alturaBruta: Decimal | null = null;
  if (item.tipo === 'CORTINA') {
    motor = calcularCortina(item.entrada, catalogo);
    larguraProducao = d(item.entrada.larguraTrilho);
    alturaProducao = d(item.entrada.alturaPronta);
  } else if (item.tipo === 'PERSIANA') {
    motor = calcularPersiana(item.entrada, catalogo);
    const m = medidaProducao(item.entrada.medida);
    larguraProducao = m.largura;
    alturaProducao = m.altura;
    if (m.vaoBruto) { larguraBruta = d(m.vaoBruto.largura); alturaBruta = d(m.vaoBruto.altura); }
  } else {
    throw new ErroEntrada('Tipo de item inválido (use CORTINA ou PERSIANA).');
  }
  const componentes = aplicarAjustes(motor.componentes, ajustes, catalogo);
  if (componentes.length === 0) throw new ErroEntrada('O item ficou sem componentes.');
  return {
    tipo: item.tipo,
    componentes,
    custoTotal: componentes.reduce((s, c) => s.plus(c.custoTotal), ZERO),
    vendaTotal: componentes.reduce((s, c) => s.plus(c.precoTotal), ZERO),
    alertas: motor.alertas,
    especificacaoTecnica: motor.especificacaoTecnica,
    larguraProducao, alturaProducao, larguraBruta, alturaBruta,
    motor,
  };
}

const br = (x: Numerico) => d(x).toFixed(2).replace('.', ',');

/** "Cortina Wave em Linho Sintetico Gaze c/ forro Forro Microfibra 80% (3,00 m x 2,60 m)". */
export function descricaoComercial(item: EntradaItem, catalogo: Catalogo): string {
  if (item.tipo === 'CORTINA') {
    const e = item.entrada;
    const conf = { WAVE: 'Wave', PREGA: 'Prega macho', FRANZIDO: 'Franzida' }[e.confeccao] ?? e.confeccao;
    const forro = e.forro ? ` c/ forro ${catalogo.obter(e.forro.sku).nome}` : '';
    return `Cortina ${conf} em ${catalogo.obter(e.tecido.sku).nome}${forro} (${br(e.larguraTrilho)} m x ${br(e.alturaPronta)} m)`;
  }
  const e = item.entrada;
  const m = medidaProducao(e.medida);
  const extras = [e.acionamento === 'MOTORIZADO' ? 'motorizada' : null, e.possuiBando ? 'c/ bandô' : null].filter(Boolean).join(', ');
  return `${catalogo.obter(e.sku).nome}${extras ? `, ${extras}` : ''} (${br(m.largura)} m x ${br(m.altura)} m)`;
}

// ------------------------------------------------------------------ totais e rateio

export interface LinhaParaRateio {
  id: string;
  vendaTotal: Numerico;
  componentes: { id: string; precoTotal: Numerico }[];
}

/**
 * Rateio do desconto (11.1 item 4): proporcional ao valor de venda de cada item e, dentro
 * do item, de cada componente. Arredondado em centavos; a sobra vai para o de maior valor.
 */
export function ratear<T extends { id: string; valor: Decimal }>(linhas: T[], total: Decimal): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  const soma = linhas.reduce((s, l) => s.plus(l.valor), ZERO);
  if (linhas.length === 0) return out;
  if (soma.isZero()) { linhas.forEach((l) => out.set(l.id, ZERO)); return out; }
  let distribuido = ZERO;
  for (const l of linhas) {
    const parte = total.mul(l.valor).div(soma).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    out.set(l.id, parte);
    distribuido = distribuido.plus(parte);
  }
  const maior = linhas.reduce((a, b) => (b.valor.gt(a.valor) ? b : a));
  out.set(maior.id, out.get(maior.id)!.plus(total.minus(distribuido)));
  return out;
}

export function ratearDesconto(itens: LinhaParaRateio[], desconto: Numerico) {
  const total = d(desconto);
  const porItem = ratear(itens.map((i) => ({ id: i.id, valor: d(i.vendaTotal) })), total);
  return itens.map((i) => {
    const descItem = porItem.get(i.id) ?? ZERO;
    const porComp = ratear(i.componentes.map((c) => ({ id: c.id, valor: d(c.precoTotal) })), descItem);
    return {
      id: i.id,
      descontoRateado: descItem,
      vendaLiquida: d(i.vendaTotal).minus(descItem),
      componentes: i.componentes.map((c) => {
        const dc = porComp.get(c.id) ?? ZERO;
        return { id: c.id, descontoRateado: dc, precoTotalLiquido: d(c.precoTotal).minus(dc) };
      }),
    };
  });
}

export interface CondicoesOrcamento {
  /** Desconto em % do subtotal ou em R$. */
  descontoTipo: 'PERCENTUAL' | 'VALOR';
  descontoValor: Numerico;
  acrescimo?: Numerico;
}

export interface ParametrosMargem {
  /** Taxa da forma de pagamento (MDR + antecipação), em %. */
  taxaPagamentoPct?: Numerico;
  /** ALIQUOTA_IMPOSTO_VENDA_PCT (MEI: 0). */
  aliquotaImpostoPct?: Numerico;
  /** Comissão do vendedor, em %. */
  comissaoPct?: Numerico;
  limites?: LimitesSemaforo;
}

export interface TotaisOrcamento {
  subtotal: Decimal;
  descontoValor: Decimal;
  descontoPct: Decimal;
  acrescimo: Decimal;
  total: Decimal;
  custoTotal: Decimal;
  lucroBruto: Decimal;
  margemBrutaPct: Decimal;
  taxaPagamento: Decimal;
  imposto: Decimal;
  comissao: Decimal;
  lucroLiquido: Decimal;
  /** Margem líquida (após taxa, imposto e comissão): é a que vale para o semáforo (11.1 item 3). */
  margemLiquidaPct: Decimal;
  semaforo: CorSemaforo;
}

export function totalizarOrcamento(
  itens: { vendaTotal: Numerico; custoTotal: Numerico }[],
  cond: CondicoesOrcamento,
  p: ParametrosMargem = {},
): TotaisOrcamento {
  const subtotal = itens.reduce((s, i) => s.plus(d(i.vendaTotal)), ZERO);
  const custoTotal = itens.reduce((s, i) => s.plus(d(i.custoTotal)), ZERO);
  const v = d(cond.descontoValor || 0);
  if (v.lt(0)) throw new ErroEntrada('Desconto não pode ser negativo.');
  let descontoValor: Decimal;
  if (cond.descontoTipo === 'PERCENTUAL') {
    if (v.gt(100)) throw new ErroEntrada('Desconto acima de 100%.');
    descontoValor = dinheiro(subtotal.mul(v).div(100));
  } else {
    descontoValor = dinheiro(v);
  }
  if (descontoValor.gt(subtotal)) throw new ErroEntrada('Desconto maior que o valor do orçamento.');
  const descontoPct = subtotal.isZero() ? ZERO : descontoValor.div(subtotal).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const acrescimo = dinheiro(d(cond.acrescimo || 0));
  if (acrescimo.lt(0)) throw new ErroEntrada('Acréscimo não pode ser negativo.');
  const total = subtotal.minus(descontoValor).plus(acrescimo);
  const pct = (x: Numerico | undefined) => dinheiro(total.mul(d(x ?? 0)).div(100));
  const taxaPagamento = pct(p.taxaPagamentoPct);
  const imposto = pct(p.aliquotaImpostoPct);
  const comissao = pct(p.comissaoPct);
  const lucroBruto = total.minus(custoTotal);
  const lucroLiquido = lucroBruto.minus(taxaPagamento).minus(imposto).minus(comissao);
  const margemLiquidaPct = margemPct(lucroLiquido, total);
  return {
    subtotal, descontoValor, descontoPct, acrescimo, total, custoTotal,
    lucroBruto, margemBrutaPct: margemPct(lucroBruto, total),
    taxaPagamento, imposto, comissao, lucroLiquido, margemLiquidaPct,
    semaforo: semaforoMargem(margemLiquidaPct, p.limites ?? LIMITES_SEMAFORO_PADRAO).cor,
  };
}

/**
 * O desconto do orçamento vale só no PIX à vista (Gabriel, 27/11/2026). Forma "a combinar" (vazia)
 * mostra o preço do PIX. Cartão, débito, boleto e dinheiro pagam o valor cheio.
 */
export function descontoValeNaForma(forma: string | null | undefined): boolean {
  return !forma || forma === 'PIX';
}

export interface TetoDesconto {
  /** Maior desconto (R$, sobre o subtotal) que ainda deixa a margem líquida >= alvoPct. */
  valor: Decimal;
  /** O mesmo em % do subtotal (para baixo, 2 casas). */
  pct: Decimal;
  alvoPct: Decimal;
}

/**
 * Teto de desconto (Gabriel, 27/11/2026): quanto o vendedor pode dar de desconto sem a margem
 * líquida cair abaixo de `alvoPct`. Usa a mesma conta de `totalizarOrcamento` (taxa, imposto e
 * comissão em % do total). Nunca vai para o cliente (PDF/WhatsApp): só para a tela do vendedor.
 */
export function tetoDesconto(
  itens: { vendaTotal: Numerico; custoTotal: Numerico }[],
  acrescimo: Numerico,
  p: ParametrosMargem,
  alvoPct: Numerico,
): TetoDesconto {
  const alvo = d(alvoPct);
  const subtotal = itens.reduce((s, i) => s.plus(d(i.vendaTotal)), ZERO);
  const custo = itens.reduce((s, i) => s.plus(d(i.custoTotal)), ZERO);
  const acr = dinheiro(d(acrescimo || 0));
  const zero = { valor: ZERO, pct: ZERO, alvoPct: alvo };
  if (subtotal.lte(0)) return zero;
  const variaveis = d(p.taxaPagamentoPct ?? 0).plus(d(p.aliquotaImpostoPct ?? 0)).plus(d(p.comissaoPct ?? 0));
  const sobra = d(1).minus(alvo.div(100)).minus(variaveis.div(100));
  if (sobra.lte(0)) return zero;
  // total mínimo = custo / (1 - alvo - taxa - imposto - comissão)
  const totalMinimo = custo.div(sobra);
  let valor = Decimal.min(subtotal, subtotal.plus(acr).minus(totalMinimo)).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  if (valor.lte(0)) return zero;
  // Ajuste fino por causa dos arredondamentos em centavos.
  const cond = (v: Decimal): CondicoesOrcamento => ({ descontoTipo: 'VALOR', descontoValor: v.toFixed(2), acrescimo: acr.toFixed(2) });
  for (let i = 0; i < 200 && valor.gt(0) && totalizarOrcamento(itens, cond(valor), p).margemLiquidaPct.lt(alvo); i++) {
    valor = valor.minus('0.01');
  }
  if (valor.lte(0)) return zero;
  return { valor, pct: valor.div(subtotal).mul(100).toDecimalPlaces(2, Decimal.ROUND_DOWN), alvoPct: alvo };
}

export interface ChecagemLiberacao {
  exige: boolean;
  motivos: string[];
}

/**
 * Trava de desconto (11.1 item 3): precisa da senha do ADMIN quando a margem fica
 * vermelha ou o desconto passa do limite do vendedor (`desconto_max_pct`).
 */
export function checarLiberacao(t: Pick<TotaisOrcamento, 'semaforo' | 'descontoPct' | 'margemLiquidaPct'>, descontoMaxPct: Numerico | null): ChecagemLiberacao {
  const motivos: string[] = [];
  if (t.semaforo === 'VERMELHO') motivos.push(`Margem vermelha (${t.margemLiquidaPct.toFixed(2).replace('.', ',')}%).`);
  if (descontoMaxPct != null && t.descontoPct.gt(d(descontoMaxPct))) {
    motivos.push(`Desconto de ${t.descontoPct.toFixed(2).replace('.', ',')}% acima do limite do vendedor (${d(descontoMaxPct).toFixed(2).replace('.', ',')}%).`);
  }
  return { exige: motivos.length > 0, motivos };
}

// ------------------------------------------------------------------ garantia por item

/**
 * Garantia em meses (Gabriel, 27/11/2026): padrão 12 meses; Persiana Rolo, Double Vision e
 * Painel 24 meses; motores (cortina ou persiana) 60 meses. `garantia_meses` na metadata do
 * produto, quando preenchido, vale mais que a regra.
 */
export function garantiaMesesProduto(p: Pick<Produto, 'nome' | 'metadata'>): number {
  const m = p.metadata?.['garantia_meses'];
  if (m !== undefined && m !== null && m !== '' && Number.isFinite(Number(m))) return Math.round(Number(m));
  if (/motor/i.test(p.nome) || p.metadata?.['torque_nm'] !== undefined) return 60;
  if (/persiana/i.test(p.nome) && /(rolo|double vision|painel)/i.test(p.nome)) return 24;
  return 12;
}

export interface GarantiaItem {
  /** Garantia do produto principal do item (primeiro componente: tecido ou persiana). */
  meses: number;
  /** Garantia do motor, quando o item é motorizado. */
  motorMeses: number | null;
}

export function garantiaDoItem(skus: string[], catalogo: Catalogo): GarantiaItem {
  let meses = 12;
  let motorMeses: number | null = null;
  skus.forEach((sku, i) => {
    let p: Produto;
    try { p = catalogo.obter(sku); } catch { return; }
    const g = garantiaMesesProduto(p);
    const ehMotor = /motor/i.test(p.nome) || p.metadata?.['torque_nm'] !== undefined;
    if (ehMotor) motorMeses = Math.max(motorMeses ?? 0, g);
    else if (i === 0) meses = g;
  });
  return { meses, motorMeses };
}

export function textoGarantia(g: GarantiaItem): string {
  const t = (m: number) => (m >= 24 && m % 12 === 0 ? `${m / 12} anos` : `${m} meses`);
  return g.motorMeses ? `${t(g.meses)}; motor ${t(g.motorMeses)}` : t(g.meses);
}

// ------------------------------------------------------------------ controle remoto

export interface OpcaoControle { sku: string; canais: number }

/**
 * Sugestão de controle remoto (proposta, a confirmar com o Gabriel): cada canal aciona 1 peça
 * motorizada. Para N peças agrupadas (padrão: o ambiente), sugere o MENOR controle que cubra todas;
 * acima do maior, usa vários do maior e completa com o menor que cubra o resto. O vendedor pode mudar.
 */
export function sugerirControles(pecas: number, opcoes: OpcaoControle[]): { sku: string; canais: number; quantidade: number }[] {
  if (pecas <= 0 || opcoes.length === 0) return [];
  const ord = [...opcoes].filter((o) => o.canais > 0).sort((a, b) => a.canais - b.canais);
  if (ord.length === 0) return [];
  const maior = ord[ord.length - 1]!;
  const out = new Map<string, { sku: string; canais: number; quantidade: number }>();
  const somar = (o: OpcaoControle) => {
    const x = out.get(o.sku) ?? { ...o, quantidade: 0 };
    x.quantidade++;
    out.set(o.sku, x);
  };
  let resto = pecas;
  while (resto > maior.canais) { somar(maior); resto -= maior.canais; }
  somar(ord.find((o) => o.canais >= resto)!);
  return [...out.values()];
}
