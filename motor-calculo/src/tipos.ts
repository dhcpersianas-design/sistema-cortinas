import type { Decimal, Numerico } from './decimal.js';

export type UnidadeMedida = 'M2' | 'ML' | 'UN' | 'PC';

/** Produto do catálogo (espelha a tabela `produtos` + `metadata_tecnica` JSONB). */
export interface Produto {
  sku: string;
  nome: string;
  unidade: UnidadeMedida;
  custoUnitario: Numerico;
  precoVendaUnitario: Numerico;
  metadata?: Record<string, unknown>;
  /** Caminho da categoria no catálogo (ex.: "Persianas › Rolo › Double Vision"). Opcional. */
  categoria?: string;
  /** Status de disponibilidade (ver disponibilidade.ts). Ausente = disponível. */
  disponibilidade?: { status: string; previsao?: string | null };
}

/** Fonte de produtos. O motor só lê; quem chama decide de onde vêm (banco, seed, mock). */
export interface Catalogo {
  obter(sku: string): Produto;
}

export type Severidade = 'INFO' | 'ATENCAO' | 'CRITICO';

export interface Alerta {
  codigo: string;
  severidade: Severidade;
  mensagem: string;
  /** SKU sugerido para resolver o alerta (ex.: ACP-003). */
  skuSugerido?: string;
}

export interface ComponenteCalculado {
  sku: string;
  descricao: string;
  unidade: UnidadeMedida;
  quantidade: Decimal;
  /** Snapshot do custo no momento do cálculo (já com multiplicadores, se houver). */
  custoUnitario: Decimal;
  precoUnitario: Decimal;
  custoTotal: Decimal;
  precoTotal: Decimal;
  formulaLog: string;
}

export interface ResultadoCalculo {
  tipo: 'CORTINA' | 'PERSIANA';
  componentes: ComponenteCalculado[];
  custoTotalItem: Decimal;
  vendaTotalItem: Decimal;
  lucroBrutoItem: Decimal;
  /** Percentual com 2 casas (ex.: 61.61). */
  margemBrutaPct: Decimal;
  alertas: Alerta[];
  /** Só as mensagens (compatível com `warnings[]` da especificação). */
  warnings: string[];
  /** Dados técnicos para a Ordem de Produção (sem valores). */
  especificacaoTecnica: Record<string, unknown>;
}
