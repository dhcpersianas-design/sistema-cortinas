/**
 * Prazo em DIAS ÚTEIS (decisão do Gabriel, 27/11/2026): conta de segunda a sexta, sem sábado e domingo.
 * Feriados não entram (o ADMIN ajusta a data no pedido quando cair num feriado).
 * Datas no formato AAAA-MM-DD, sem fuso (dia do calendário).
 */
export function somarDiasUteis(inicio: string, dias: number): string {
  const [a, m, d] = inicio.slice(0, 10).split('-').map(Number);
  const data = new Date(Date.UTC(a!, m! - 1, d!));
  let falta = Math.max(0, Math.round(dias));
  while (falta > 0) {
    data.setUTCDate(data.getUTCDate() + 1);
    const dia = data.getUTCDay();
    if (dia !== 0 && dia !== 6) falta--;
  }
  return data.toISOString().slice(0, 10);
}

/** Hoje no fuso da loja (America/Sao_Paulo), AAAA-MM-DD. */
export function hojeLoja(agora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}
