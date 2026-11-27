/**
 * Formato único dos relatórios: a mesma estrutura vira tela, PDF e planilha (XLSX).
 * Valores de dinheiro e percentual vão como texto decimal ("1234.56"), nunca float.
 */
export type TipoColuna = 'texto' | 'moeda' | 'pct' | 'int' | 'data';
export type Coluna = { chave: string; titulo: string; tipo: TipoColuna; peso?: number };
export type Celula = string | number | null;
/** _nivel 0 = linha de total (negrito), 1 = detalhe recuado; _alerta = destacar em vermelho. */
export type Linha = { [chave: string]: Celula | boolean | undefined; _alerta?: boolean; _nivel?: number };
export type Tabela = { titulo?: string; colunas: Coluna[]; linhas: Linha[]; total?: Linha; vazio?: string };
export type Kpi = { rotulo: string; valor: string; tipo: TipoColuna; alerta?: boolean };
export type Relatorio = {
  tipo: string; titulo: string; periodo: string; geradoEm: string;
  resumo: Kpi[]; tabelas: Tabela[]; observacoes: string[];
};

export type Filtros = {
  de: string; ate: string;
  regime?: 'competencia' | 'caixa';
  agrupar?: 'dia' | 'mes' | 'ano';
  nome?: string; telefone?: string; bairro?: string; produto?: string; forma?: string;
  instalacaoDe?: string; instalacaoAte?: string; usarPeriodo?: boolean;
};

export const RELATORIOS = [
  { id: 'dre', titulo: 'DRE gerencial', descricao: 'Receita, deduções, custo (CMV), despesas e lucro líquido do período. Por competência ou por caixa.' },
  { id: 'faturamento', titulo: 'Faturamento', descricao: 'Vendas por dia, mês ou ano: pedidos, valor, ticket médio e formas de pagamento.' },
  { id: 'rentabilidade', titulo: 'Rentabilidade por pedido', descricao: 'Lucro real de cada pedido: venda, custo previsto x real, taxas, comissão e margem.' },
  { id: 'fluxo-caixa', titulo: 'Fluxo de caixa', descricao: 'Saldo inicial, entradas e saídas (previsto x realizado) e saldo projetado para 30, 60 e 90 dias.' },
  { id: 'contas', titulo: 'Contas a pagar e a receber', descricao: 'Vencidos, vencendo hoje, próximos 7 e 30 dias, e pedidos instalados com saldo em aberto.' },
  { id: 'funil', titulo: 'Funil de vendas', descricao: 'Orçado x aprovado, conversão por vendedor e por origem do cliente, motivos de perda.' },
  { id: 'curva-abc', titulo: 'Curva ABC', descricao: 'Produtos e categorias que mais faturam e que dão mais lucro.' },
  { id: 'clientes', titulo: 'Clientes (CRM)', descricao: 'Pesquisa por nome, telefone, bairro, compra, instalação, produto e forma de pagamento.' },
] as const;
export type TipoRelatorio = (typeof RELATORIOS)[number]['id'];
