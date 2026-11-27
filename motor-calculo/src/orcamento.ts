import type { Decimal } from './decimal.js';
import { ZERO } from './decimal.js';
import { margemPct } from './comum.js';
import type { ComponenteCalculado, ResultadoCalculo } from './tipos.js';

export interface ItemOrcamento {
  ambiente: string;
  descricao: string;
  resultado: ResultadoCalculo;
}

export interface ResumoOrcamento {
  itens: ItemOrcamento[];
  custoTotal: Decimal;
  vendaTotal: Decimal;
  lucroBruto: Decimal;
  margemBrutaPct: Decimal;
}

/** Soma os itens de um orçamento (sem descontos/taxas; isso é do módulo financeiro). */
export function resumirOrcamento(itens: ItemOrcamento[]): ResumoOrcamento {
  const custo = itens.reduce((s, i) => s.plus(i.resultado.custoTotalItem), ZERO);
  const venda = itens.reduce((s, i) => s.plus(i.resultado.vendaTotalItem), ZERO);
  const lucro = venda.minus(custo);
  return { itens, custoTotal: custo, vendaTotal: venda, lucroBruto: lucro, margemBrutaPct: margemPct(lucro, venda) };
}

/** Casas decimais de exibição por unidade (seção 3). */
const CASAS_QTD: Record<ComponenteCalculado['unidade'], number> = { M2: 2, ML: 2, UN: 0, PC: 0 };

function compJSON(c: ComponenteCalculado) {
  return {
    sku: c.sku,
    descricao: c.descricao,
    unidade: c.unidade,
    quantidade: c.unidade === 'M2' ? c.quantidade.toFixed(4) : c.quantidade.toFixed(CASAS_QTD[c.unidade]),
    custoUnitario: c.custoUnitario.toFixed(4),
    precoUnitario: c.precoUnitario.toFixed(4),
    custoTotal: c.custoTotal.toFixed(2),
    precoTotal: c.precoTotal.toFixed(2),
    formulaLog: c.formulaLog,
  };
}

/** Serializa para JSON/API/banco com strings decimais (nunca float). */
export function paraJSON(r: ResultadoCalculo) {
  return {
    tipo: r.tipo,
    componentes: r.componentes.map(compJSON),
    custoTotalItem: r.custoTotalItem.toFixed(2),
    vendaTotalItem: r.vendaTotalItem.toFixed(2),
    lucroBrutoItem: r.lucroBrutoItem.toFixed(2),
    margemBrutaPct: r.margemBrutaPct.toFixed(2),
    alertas: r.alertas,
    warnings: r.warnings,
    especificacaoTecnica: r.especificacaoTecnica,
  };
}
