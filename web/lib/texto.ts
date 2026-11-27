/** Minúsculas e sem acento, para busca local (mesma ideia do f_busca do banco). */
export function semAcento(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const data = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });
export function formatarData(v: string | null | undefined): string {
  return v ? data.format(new Date(v)) : '—';
}
