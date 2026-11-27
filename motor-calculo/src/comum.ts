import { Decimal, d, dinheiro, unitario, ZERO, type Numerico } from './decimal.js';
import type { Alerta, ComponenteCalculado, Produto, ResultadoCalculo } from './tipos.js';

/** Lê um número da metadata do SKU; usa o padrão quando ausente. */
export function metaNum(p: Produto, chave: string, padrao?: Numerico): Decimal {
  const v = p.metadata?.[chave];
  if (v === undefined || v === null) {
    if (padrao === undefined) throw new Error(`SKU ${p.sku}: metadata "${chave}" ausente`);
    return d(padrao);
  }
  if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`SKU ${p.sku}: metadata "${chave}" não é numérica`);
  return d(v);
}

export function metaBool(p: Produto, chave: string, padrao: boolean): boolean {
  const v = p.metadata?.[chave];
  return typeof v === 'boolean' ? v : padrao;
}

export function metaStr(p: Produto, chave: string): string | undefined {
  const v = p.metadata?.[chave];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Monta a linha do BOM com snapshot de custo/preço.
 * Totais da linha em 2 casas (HALF_UP); unitários em 4 casas.
 */
export function componente(
  p: Produto,
  quantidade: Decimal,
  formulaLog: string,
  multiplicadorUnitario: Decimal = new Decimal(1),
): ComponenteCalculado {
  const custoUnit = unitario(d(p.custoUnitario).mul(multiplicadorUnitario));
  const precoUnit = unitario(d(p.precoVendaUnitario).mul(multiplicadorUnitario));
  return {
    sku: p.sku,
    descricao: p.nome,
    unidade: p.unidade,
    quantidade,
    custoUnitario: custoUnit,
    precoUnitario: precoUnit,
    custoTotal: dinheiro(quantidade.mul(custoUnit)),
    precoTotal: dinheiro(quantidade.mul(precoUnit)),
    formulaLog,
  };
}

export function margemPct(lucro: Decimal, venda: Decimal): Decimal {
  if (venda.isZero()) return ZERO;
  return lucro.div(venda).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function fecharResultado(
  tipo: ResultadoCalculo['tipo'],
  componentes: ComponenteCalculado[],
  alertas: Alerta[],
  especificacaoTecnica: Record<string, unknown>,
): ResultadoCalculo {
  const custo = componentes.reduce((s, c) => s.plus(c.custoTotal), ZERO);
  const venda = componentes.reduce((s, c) => s.plus(c.precoTotal), ZERO);
  const lucro = venda.minus(custo);
  return {
    tipo,
    componentes,
    custoTotalItem: custo,
    vendaTotalItem: venda,
    lucroBrutoItem: lucro,
    margemBrutaPct: margemPct(lucro, venda),
    alertas,
    warnings: alertas.map((a) => a.mensagem),
    especificacaoTecnica,
  };
}

export const f2 = (x: Decimal) => x.toFixed(2);
