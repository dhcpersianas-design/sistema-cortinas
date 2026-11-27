'use client';
/**
 * Instalações e aceite do cliente na obra, funcionando sem internet (especificação v1.1, 12.5).
 * - Com internet, o app baixa as instalações agendadas do vendedor (GET /api/instalacoes/pacote-offline).
 * - O aceite (nome, checklist e assinatura desenhada na tela) é gravado no aparelho e enviado quando
 *   a conexão volta. O id do aceite nasce no aparelho: reenviar não duplica.
 */
import { apagar, gravar, ler, substituirTudo, todos } from './offline-db';

export type Peca = { sku: string; descricao: string; quantidade: string; unidade: string };
export type Instalacao = {
  id: string; numero: string; titulo: string | null; status: string; statusNome: string;
  clienteNome: string; clienteTelefone: string; endereco: string | null; obsAcesso: string | null;
  instalacaoAgendada: string | null; instaladorNome: string | null; obsInstalacao: string | null; saldo: string;
  itens: { id: string; ambiente: string; tipo: string; descricao: string; medidas: string; pecas: Peca[] }[];
};
export type CorpoAceite = {
  id: string; nomeRecebedor: string; documentoRecebedor: string | null; assinaturaPng: string;
  checklist: { itemId: string | null; descricao: string; ok: boolean }[];
  observacoes: string | null; assinadoEm: string; offline?: boolean;
};
type AceitePendente = { pedidoId: string; numero: string; corpo: CorpoAceite; erro?: string | null };

class ErroApi extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function chamar<T>(caminho: string, method = 'GET', corpo?: unknown): Promise<T> {
  const r = await fetch(caminho, {
    method, credentials: 'same-origin',
    headers: corpo !== undefined ? { 'content-type': 'application/json' } : {},
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi((dados as { erro?: string }).erro ?? `Erro ${r.status}`, r.status);
  return dados as T;
}
const semRede = (e: unknown) => !(e instanceof ErroApi) || e.status === 503;

/** Baixa o pacote (com internet) ou devolve o que está no aparelho. */
export async function carregarInstalacoes(): Promise<{ instalacoes: Instalacao[]; offline: boolean; baixadoEm: string | null }> {
  try {
    const r = await chamar<{ instalacoes: Instalacao[]; geradoEm: string }>('/api/instalacoes/pacote-offline');
    await substituirTudo('instalacoes', r.instalacoes);
    await gravar('meta', r.geradoEm, 'instalacoesBaixadasEm');
    return { instalacoes: r.instalacoes, offline: false, baixadoEm: r.geradoEm };
  } catch (e) {
    if (!semRede(e)) throw e;
    return {
      instalacoes: (await todos<Instalacao>('instalacoes')).sort((a, b) => (a.instalacaoAgendada ?? '').localeCompare(b.instalacaoAgendada ?? '')),
      offline: true,
      baixadoEm: (await ler<string>('meta', 'instalacoesBaixadasEm')) ?? null,
    };
  }
}

export async function lerInstalacao(id: string): Promise<Instalacao | null> {
  const local = await ler<Instalacao>('instalacoes', id);
  if (local) return local;
  const { instalacoes } = await carregarInstalacoes().catch(() => ({ instalacoes: [] as Instalacao[] }));
  return instalacoes.find((i) => i.id === id) ?? null;
}

export async function aceitePendente(pedidoId: string): Promise<AceitePendente | undefined> {
  return ler<AceitePendente>('aceites', pedidoId);
}

export type ResultadoAceite = { offline: boolean; avisos: string[] };

/** Envia o aceite; sem internet guarda no aparelho para enviar depois. */
export async function registrarAceite(i: Pick<Instalacao, 'id' | 'numero'>, corpo: CorpoAceite): Promise<ResultadoAceite> {
  try {
    const r = await chamar<{ avisos?: string[] }>(`/api/pedidos/${i.id}/aceite`, 'POST', corpo);
    await apagar('aceites', i.id);
    await apagar('instalacoes', i.id);
    return { offline: false, avisos: r.avisos ?? [] };
  } catch (e) {
    if (!semRede(e)) throw e;
    await gravar('aceites', { pedidoId: i.id, numero: i.numero, corpo: { ...corpo, offline: true }, erro: null } satisfies AceitePendente);
    return { offline: true, avisos: ['Sem internet: o aceite ficou guardado no aparelho e será enviado quando a conexão voltar.'] };
  }
}

let enviando: Promise<{ enviados: number; recusados: string[] }> | null = null;

/** Envia os aceites guardados (o mesmo id: o servidor não duplica). */
export function enviarAceitesPendentes() {
  if (enviando) return enviando;
  enviando = (async () => {
    const res = { enviados: 0, recusados: [] as string[] };
    for (const a of await todos<AceitePendente>('aceites')) {
      try {
        await chamar(`/api/pedidos/${a.pedidoId}/aceite`, 'POST', a.corpo);
        await apagar('aceites', a.pedidoId);
        await apagar('instalacoes', a.pedidoId);
        res.enviados++;
      } catch (e) {
        if (semRede(e)) break;
        await gravar('aceites', { ...a, erro: (e as Error).message });
        res.recusados.push(`${a.numero}: ${(e as Error).message}`);
      }
    }
    return res;
  })().finally(() => { enviando = null; });
  return enviando;
}

export async function contarAceitesPendentes(): Promise<number> {
  return (await todos('aceites')).length;
}
