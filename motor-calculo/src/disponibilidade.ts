/**
 * Status de disponibilidade do produto (Gabriel, 27/11/2026). Só para o vendedor:
 * vira alerta no item do orçamento e nunca vai para o PDF do cliente.
 * - Em falta (com ou sem previsão): avisa, mostra a previsão.
 * - Fora de linha: alerta crítico; o orçamento não pode ser enviado com ele.
 * - Sob consulta: o preço do catálogo não vale sozinho; precisa ser confirmado com o fornecedor.
 */
import type { Alerta, Catalogo, Produto } from './tipos.js';

export const STATUS_DISPONIBILIDADE = ['DISPONIVEL', 'EM_FALTA_SEM_PREVISAO', 'EM_FALTA_COM_PREVISAO', 'FORA_DE_LINHA', 'SOB_CONSULTA'] as const;
export type StatusDisponibilidade = typeof STATUS_DISPONIBILIDADE[number];

export const ROTULO_DISPONIBILIDADE: Record<StatusDisponibilidade, string> = {
  DISPONIVEL: 'Disponível',
  EM_FALTA_SEM_PREVISAO: 'Em falta sem previsão',
  EM_FALTA_COM_PREVISAO: 'Em falta com previsão',
  FORA_DE_LINHA: 'Fora de linha',
  SOB_CONSULTA: 'Sob consulta',
};

/** "2026-12-10" → "10/12/2026". */
export function dataBr(iso: string | null | undefined): string {
  if (!iso) return '';
  const [a, m, dd] = iso.slice(0, 10).split('-');
  return `${dd}/${m}/${a}`;
}

/** Texto curto do status, com a previsão: "Em falta, previsão 10/12/2026". */
export function textoDisponibilidade(status: string | null | undefined, previsao?: string | null): string {
  const s = (status ?? 'DISPONIVEL') as StatusDisponibilidade;
  if (s === 'EM_FALTA_COM_PREVISAO') return `Em falta, previsão ${dataBr(previsao)}`;
  return ROTULO_DISPONIBILIDADE[s] ?? s;
}

/** Alertas de disponibilidade dos produtos usados no item (um por produto). `hoje` = "AAAA-MM-DD". */
export function alertasDisponibilidade(skus: string[], catalogo: Catalogo, hoje: string = new Date().toISOString().slice(0, 10)): Alerta[] {
  const r: Alerta[] = [];
  for (const sku of [...new Set(skus)]) {
    let p: Produto;
    try { p = catalogo.obter(sku); } catch { continue; }
    const s = p.disponibilidade?.status ?? 'DISPONIVEL';
    const prev = p.disponibilidade?.previsao ?? null;
    const nome = `${p.nome} (${p.sku})`;
    if (s === 'EM_FALTA_SEM_PREVISAO') {
      r.push({ codigo: 'PRODUTO_EM_FALTA', severidade: 'ATENCAO', mensagem: `${nome} está em falta, sem previsão de chegada. Confirme o prazo com o fornecedor antes de fechar.` });
    } else if (s === 'EM_FALTA_COM_PREVISAO') {
      const vencida = prev !== null && prev < hoje;
      r.push({ codigo: 'PRODUTO_EM_FALTA', severidade: 'ATENCAO', mensagem: vencida
        ? `${nome} está em falta e a previsão (${dataBr(prev)}) já passou. Confirme com o fornecedor.`
        : `${nome} está em falta, previsão de chegada ${dataBr(prev)}. Considere no prazo de entrega.` });
    } else if (s === 'FORA_DE_LINHA') {
      r.push({ codigo: 'PRODUTO_FORA_DE_LINHA', severidade: 'CRITICO', mensagem: `${nome} está fora de linha: troque o produto. O orçamento não pode ser enviado com ele.` });
    } else if (s === 'SOB_CONSULTA') {
      r.push({ codigo: 'PRODUTO_SOB_CONSULTA', severidade: 'CRITICO', mensagem: `${nome} é sob consulta: o preço não é automático. Confirme o valor com o fornecedor; só o administrador envia este orçamento.` });
    }
  }
  return r;
}
