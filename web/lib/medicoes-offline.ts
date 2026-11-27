'use client';
/**
 * Medição na obra, funcionando sem internet (especificação v1.1, 12.5).
 * - Com internet, o app baixa as visitas do usuário (GET /api/medicoes/pacote-offline) e guarda no aparelho.
 * - Os vãos medidos e as fotos ficam no aparelho e são enviados quando a conexão volta. Os ids nascem
 *   no aparelho (registro e cada foto): reenviar não duplica.
 * - Marcar, remarcar e conferir precisam de internet (mexem em orçamento, pedido e prazo).
 */
import { apagar, gravar, ler, substituirTudo, todos } from './offline-db';

export type Vao = {
  id: string; ambiente: string; descricao: string; tipo: 'CORTINA' | 'PERSIANA';
  modo: 'DENTRO_VAO' | 'FORA_VAO' | 'TETO' | null;
  larguras: string[]; alturas: string[];
  ladoComando: 'DIREITO' | 'ESQUERDO' | null; profundidadeCortineiroM: string | null;
  observacoes: string | null; itemId: string | null;
};
export type FotoInfo = { id: string; vaoId: string | null; legenda: string | null; tamanho?: number; criadoEm?: string; dataUrl?: string; pendente?: boolean };
export type ItemOrcamento = { id: string; ambiente: string; tipo: string; descricao: string; larguraBruta: string | null; alturaBruta: string | null; larguraProducao: string; alturaProducao: string };
export type Medicao = {
  id: string; numero: string; status: string; statusNome: string; statusBanco: string;
  dataAgendada: string; duracaoHoras: string | null; dataRealizada: string | null; observacoes: string | null; obsCampo: string | null;
  responsavelId: string | null; responsavelNome: string | null;
  clienteId: string; clienteNome: string; clienteTelefone: string; endereco: string | null; obsAcesso: string | null;
  orcamentoId: string | null; orcamentoCodigo: string | null; orcamentoAtualId: string | null; orcamentoAtualVersao: number | null; orcamentoAtualStatus: string | null;
  pedidoId: string | null; pedidoNumero: string | null; pedidoStatus: string | null;
  vaos: Vao[]; registradoOffline: boolean; conferidaEm: string | null; conferidaPorNome: string | null; orcamentoGeradoId: string | null;
  canceladaEm: string | null; motivoCancelamento: string | null;
  fotos: FotoInfo[]; itens: ItemOrcamento[];
  conferencia: { pode: boolean; destino: 'PEDIDO' | 'ORCAMENTO' | 'NENHUM' | 'REGISTRO'; explicacao: string };
  /** Só no aparelho: há registro esperando internet. */
  pendente?: boolean;
};
export type CorpoRegistro = { registroId: string; vaos: Vao[]; obsCampo: string | null; realizadaEm: string; offline?: boolean };
type RegistroPendente = { medicaoId: string; numero: string; corpo: CorpoRegistro; erro?: string | null };
type FotoPendente = { id: string; medicaoId: string; numero: string; vaoId: string | null; legenda: string | null; dataUrl: string; erro?: string | null };

export class ErroApi extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function chamar<T>(caminho: string, method = 'GET', corpo?: unknown): Promise<T> {
  const r = await fetch(caminho, {
    method, credentials: 'same-origin',
    headers: corpo !== undefined ? { 'content-type': 'application/json' } : {},
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi((dados as { erro?: string }).erro ?? `Erro ${r.status}`, r.status);
  return dados as T;
}
export const semRede = (e: unknown) => !(e instanceof ErroApi) || e.status === 503;

/** Junta no que veio da API o que ainda está só no aparelho (registro e fotos pendentes). */
async function comPendencias(m: Medicao): Promise<Medicao> {
  const reg = await ler<RegistroPendente>('medicoesPendentes', m.id);
  const fotos = (await todos<FotoPendente>('fotosPendentes')).filter((f) => f.medicaoId === m.id);
  const base = reg
    ? { ...m, vaos: reg.corpo.vaos, obsCampo: reg.corpo.obsCampo, dataRealizada: reg.corpo.realizadaEm, status: 'REALIZADA', statusNome: 'Medida (aguardando internet)', pendente: true }
    : m;
  return { ...base, fotos: [...m.fotos, ...fotos.filter((f) => !m.fotos.some((x) => x.id === f.id)).map((f) => ({ id: f.id, vaoId: f.vaoId, legenda: f.legenda, dataUrl: f.dataUrl, pendente: true }))] };
}

/** Baixa o pacote da obra (com internet) ou usa o que está no aparelho. */
export async function carregarPacote(): Promise<{ medicoes: Medicao[]; offline: boolean; baixadoEm: string | null }> {
  try {
    const r = await chamar<{ medicoes: Medicao[]; geradoEm: string }>('/api/medicoes/pacote-offline');
    // Mantém no aparelho as que têm registro pendente, mesmo que não venham mais no pacote.
    const pend = await todos<RegistroPendente>('medicoesPendentes');
    const locais = await todos<Medicao>('medicoes');
    const extras = locais.filter((l) => pend.some((p) => p.medicaoId === l.id) && !r.medicoes.some((m) => m.id === l.id));
    await substituirTudo('medicoes', [...r.medicoes, ...extras]);
    await gravar('meta', r.geradoEm, 'medicoesBaixadasEm');
    return { medicoes: await Promise.all([...r.medicoes, ...extras].map(comPendencias)), offline: false, baixadoEm: r.geradoEm };
  } catch (e) {
    if (!semRede(e)) throw e;
    const locais = (await todos<Medicao>('medicoes')).sort((a, b) => a.dataAgendada.localeCompare(b.dataAgendada));
    return { medicoes: await Promise.all(locais.map(comPendencias)), offline: true, baixadoEm: (await ler<string>('meta', 'medicoesBaixadasEm')) ?? null };
  }
}

/** Abre a medição: da API (e guarda no aparelho) ou do aparelho, sem internet. */
export async function abrirMedicao(id: string): Promise<{ medicao: Medicao | null; offline: boolean }> {
  try {
    const r = await chamar<{ medicao: Medicao }>(`/api/medicoes/${id}`);
    await gravar('medicoes', r.medicao);
    return { medicao: await comPendencias(r.medicao), offline: false };
  } catch (e) {
    if (!semRede(e)) throw e;
    const local = await ler<Medicao>('medicoes', id);
    return { medicao: local ? await comPendencias(local) : null, offline: true };
  }
}

/** Grava os vãos: envia ou, sem internet, guarda no aparelho. */
export async function registrar(m: Pick<Medicao, 'id' | 'numero'>, corpo: CorpoRegistro): Promise<{ offline: boolean; medicao: Medicao | null }> {
  try {
    const r = await chamar<{ medicao: Medicao }>(`/api/medicoes/${m.id}/registro`, 'POST', corpo);
    await apagar('medicoesPendentes', m.id);
    await gravar('medicoes', r.medicao);
    return { offline: false, medicao: await comPendencias(r.medicao) };
  } catch (e) {
    if (!semRede(e)) throw e;
    await gravar('medicoesPendentes', { medicaoId: m.id, numero: m.numero, corpo: { ...corpo, offline: true }, erro: null } satisfies RegistroPendente);
    const local = await ler<Medicao>('medicoes', m.id);
    return { offline: true, medicao: local ? await comPendencias(local) : null };
  }
}

/** Foto do vão: envia ou guarda no aparelho. */
export async function adicionarFoto(m: Pick<Medicao, 'id' | 'numero'>, f: { id: string; vaoId: string | null; legenda: string | null; dataUrl: string }): Promise<{ offline: boolean }> {
  try {
    await chamar(`/api/medicoes/${m.id}/fotos`, 'POST', f);
    return { offline: false };
  } catch (e) {
    if (!semRede(e)) throw e;
    await gravar('fotosPendentes', { ...f, medicaoId: m.id, numero: m.numero, erro: null } satisfies FotoPendente);
    return { offline: true };
  }
}

export async function removerFoto(medicaoId: string, fotoId: string, pendente: boolean) {
  if (pendente) { await apagar('fotosPendentes', fotoId); return; }
  await chamar(`/api/medicoes/${medicaoId}/fotos/${fotoId}`, 'DELETE');
}

let enviando: Promise<{ enviados: number; recusados: string[] }> | null = null;

/** Envia o que ficou no aparelho (vãos primeiro, depois as fotos). */
export function enviarPendentes() {
  if (enviando) return enviando;
  enviando = (async () => {
    const res = { enviados: 0, recusados: [] as string[] };
    for (const r of await todos<RegistroPendente>('medicoesPendentes')) {
      try {
        const x = await chamar<{ medicao: Medicao }>(`/api/medicoes/${r.medicaoId}/registro`, 'POST', r.corpo);
        await apagar('medicoesPendentes', r.medicaoId);
        await gravar('medicoes', x.medicao);
        res.enviados++;
      } catch (e) {
        if (semRede(e)) return res;
        await gravar('medicoesPendentes', { ...r, erro: (e as Error).message });
        res.recusados.push(`${r.numero}: ${(e as Error).message}`);
      }
    }
    for (const f of await todos<FotoPendente>('fotosPendentes')) {
      try {
        await chamar(`/api/medicoes/${f.medicaoId}/fotos`, 'POST', { id: f.id, vaoId: f.vaoId, legenda: f.legenda, dataUrl: f.dataUrl });
        await apagar('fotosPendentes', f.id);
        res.enviados++;
      } catch (e) {
        if (semRede(e)) return res;
        await gravar('fotosPendentes', { ...f, erro: (e as Error).message });
        res.recusados.push(`Foto da ${f.numero}: ${(e as Error).message}`);
      }
    }
    return res;
  })().finally(() => { enviando = null; });
  return enviando;
}

export async function contarPendentes(): Promise<number> {
  return (await todos('medicoesPendentes')).length + (await todos('fotosPendentes')).length;
}

/** Reduz a foto do celular (até 1600 px, JPEG) para caber na rede ruim e no banco. */
export async function reduzirFoto(arquivo: File, maximo = 1600, qualidade = 0.75): Promise<string> {
  const url = URL.createObjectURL(arquivo);
  try {
    const img = await new Promise<HTMLImageElement>((ok, falha) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => falha(new Error('Não deu para abrir esta foto.'));
      i.src = url;
    });
    const escala = Math.min(1, maximo / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * escala));
    c.height = Math.max(1, Math.round(img.naturalHeight * escala));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', qualidade);
  } finally { URL.revokeObjectURL(url); }
}

/** "260" (cm) ou "2,60" (m) -> metros com até 4 casas. Devolve null se vazio. */
export function cmParaMetros(v: string): string | null {
  const t = v.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n / 100).toFixed(4).replace(/\.?0+$/, '');
}
export const metrosParaCm = (v: string | null | undefined) => (v ? String(Math.round(Number(v) * 1000) / 10).replace('.', ',') : '');
export const metrosTxt = (v: string | null | undefined) => (v ? `${Number(v).toFixed(2).replace('.', ',')} m` : '-');
