/** Formatação pt-BR a partir das strings decimais da API (nunca soma com float). */
export function moeda(v: string | null | undefined): string {
  if (v == null || v === '') return '';
  const [i, dec = '00'] = Number(v).toFixed(2).split('.');
  const neg = i!.startsWith('-');
  const int = (neg ? i!.slice(1) : i!).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '- ' : ''}R$ ${int},${dec}`;
}

export function qtd(v: string, unidade: string): string {
  const n = Number(v);
  return unidade === 'UN' || unidade === 'PC' ? String(Math.round(n)) : n.toFixed(2).replace('.', ',');
}

export const metros = (v?: string) => (v ? `${Number(v).toFixed(2).replace('.', ',')} m` : '');
export const pct = (v?: string) => (v ? `${Number(v).toFixed(2).replace('.', ',')}%` : '');

export const STATUS: Record<string, string> = {
  RASCUNHO: 'Rascunho', ENVIADO: 'Enviado', AGUARDANDO_MEDICAO: 'Aguardando medição', EM_NEGOCIACAO: 'Em negociação',
  APROVADO: 'Aprovado', PERDIDO: 'Perdido', EXPIRADO: 'Expirado',
};

export const FORMAS: [string, string][] = [
  ['PIX', 'PIX'], ['CREDITO_AVISTA', 'Crédito à vista'], ['CREDITO_PARCELADO', 'Crédito parcelado'], ['DEBITO', 'Débito'],
  ['BOLETO', 'Boleto'], ['DINHEIRO', 'Dinheiro'], ['MISTO', 'Combinado'],
];

export function corSemaforo(s?: string | null): string {
  if (s === 'VERDE') return 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  if (s === 'AMARELO') return 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400';
  if (s === 'VERMELHO') return 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400';
  return 'text-muted-foreground';
}
export const nomeSemaforo = (s?: string | null) => ({ VERDE: 'Margem verde', AMARELO: 'Margem amarela', VERMELHO: 'Margem vermelha' }[s ?? ''] ?? 'Margem conferida ao sincronizar');
