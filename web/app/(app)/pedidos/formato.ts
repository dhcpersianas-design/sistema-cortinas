export const STATUS_PEDIDO: Record<string, string> = {
  CONFERENCIA_MEDIDAS: 'Conferência de medidas',
  AGUARDANDO_SINAL: 'Aguardando sinal',
  EM_COMPRA: 'Em compra',
  EM_PRODUCAO: 'Em produção',
  PRONTO_ESTOQUE: 'Pronto para instalar',
  INSTALACAO_AGENDADA: 'Instalação agendada',
  INSTALADO_CONCLUIDO: 'Instalado',
  CANCELADO: 'Cancelado',
};

/** Ordem das etapas (barra de progresso do pedido). */
export const ETAPAS = ['CONFERENCIA_MEDIDAS', 'AGUARDANDO_SINAL', 'EM_COMPRA', 'EM_PRODUCAO', 'PRONTO_ESTOQUE', 'INSTALACAO_AGENDADA', 'INSTALADO_CONCLUIDO'];

export function corStatus(s: string): string {
  if (s === 'INSTALADO_CONCLUIDO') return 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  if (s === 'CANCELADO') return 'text-muted-foreground';
  if (s === 'CONFERENCIA_MEDIDAS' || s === 'AGUARDANDO_SINAL') return 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400';
  return 'border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-400';
}

export const dataBR = (v?: string | null) => (v ? v.slice(0, 10).split('-').reverse().join('/') : '');
export const dataHoraBR = (v?: string | null) => (v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
export const diaSemana = (v: string) => new Date(v).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });

/** "AAAA-MM-DDTHH:mm" no fuso do aparelho -> ISO com fuso (para a API). */
export function localParaIso(v: string): string {
  return new Date(v).toISOString();
}
/** ISO -> valor de <input type="datetime-local"> no fuso do aparelho. */
export function isoParaLocal(v?: string | null): string {
  if (!v) return '';
  const dt = new Date(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
export const hojeISO = () => {
  const dt = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};
