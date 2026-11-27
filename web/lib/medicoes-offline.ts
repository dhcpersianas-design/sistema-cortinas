'use client';
/**
 * Agenda e medição funcionando sem internet (especificação v1.1, 12.5; decisão do Gabriel, 27/11/2026:
 * marcar e conferir também precisam funcionar com internet fraca).
 * - Com internet, o app baixa as visitas do usuário (GET /api/medicoes/pacote-offline) e guarda no aparelho.
 * - Sem internet, tudo vai para filas no aparelho e é enviado quando a conexão volta, nesta ordem:
 *   clientes novos -> visitas marcadas -> vãos medidos -> fotos -> remarcar/cancelar/conferir.
 * - Os ids nascem no aparelho (visita, registro, foto, operação): reenviar não duplica.
 * - Conflitos não sobrescrevem: remarcação baseada numa cópia antiga é recusada (o app avisa) e
 *   conferência de visita que alguém já conferiu vira só aviso.
 */
import { apagar, gravar, ler, substituirTudo, todos } from './offline-db';
import { enviarFila as enviarClientes, type Cliente } from './clientes-offline';
import type { Orcamento } from './orcamentos-offline';

export type Vao = {
  id: string; ambiente: string; descricao: string; tipo: 'CORTINA' | 'PERSIANA';
  modo: 'DENTRO_VAO' | 'FORA_VAO' | 'TETO' | null;
  larguras: string[]; alturas: string[];
  ladoComando: 'DIREITO' | 'ESQUERDO' | null; profundidadeCortineiroM: string | null;
  observacoes: string | null; itemId: string | null;
};
export type FotoInfo = { id: string; vaoId: string | null; legenda: string | null; tamanho?: number; criadoEm?: string; dataUrl?: string; pendente?: boolean };
export type ItemOrcamento = { id: string; ambiente: string; tipo: string; descricao: string; larguraBruta: string | null; alturaBruta: string | null; larguraProducao: string; alturaProducao: string };
export type Conferencia = { pode: boolean; destino: 'PEDIDO' | 'ORCAMENTO' | 'NENHUM' | 'REGISTRO'; explicacao: string };
export type Medicao = {
  id: string; numero: string; status: string; statusNome: string; statusBanco: string;
  dataAgendada: string; duracaoHoras: string | null; dataRealizada: string | null; observacoes: string | null; obsCampo: string | null;
  responsavelId: string | null; responsavelNome: string | null;
  clienteId: string; clienteNome: string; clienteTelefone: string; endereco: string | null; obsAcesso: string | null;
  orcamentoId: string | null; orcamentoCodigo: string | null; orcamentoAtualId: string | null; orcamentoAtualVersao: number | null; orcamentoAtualStatus: string | null;
  pedidoId: string | null; pedidoNumero: string | null; pedidoStatus: string | null;
  vaos: Vao[]; registradoOffline: boolean; conferidaEm: string | null; conferidaPorNome: string | null; orcamentoGeradoId: string | null;
  canceladaEm: string | null; motivoCancelamento: string | null; atualizadoEm: string;
  fotos: FotoInfo[]; itens: ItemOrcamento[];
  conferencia: Conferencia;
  /** Só no aparelho: há algo desta visita esperando internet. */
  pendente?: boolean;
};
export type CorpoRegistro = { registroId: string; vaos: Vao[]; obsCampo: string | null; realizadaEm: string; offline?: boolean };
export type CorpoAgendar = {
  id: string; clienteId: string; orcamentoId: string | null; dataAgendada: string; duracaoHoras: string | null;
  responsavelId: string | null; observacoes: string | null;
};
export type CorpoRemarcar = { dataAgendada: string; duracaoHoras: string | null; responsavelId: string | null; observacoes: string | null; atualizadoEmBase?: string };
type RegistroPendente = { medicaoId: string; numero: string; corpo: CorpoRegistro; erro?: string | null };
type FotoPendente = { id: string; medicaoId: string; numero: string; vaoId: string | null; legenda: string | null; dataUrl: string; erro?: string | null };
type Op =
  | { idOperacao: string; criadaEm: string; medicaoId: string; numero: string; tipo: 'AGENDAR'; corpo: CorpoAgendar; erro?: string | null }
  | { idOperacao: string; criadaEm: string; medicaoId: string; numero: string; tipo: 'REMARCAR'; corpo: CorpoRemarcar; responsavelNome?: string | null; erro?: string | null }
  | { idOperacao: string; criadaEm: string; medicaoId: string; numero: string; tipo: 'CANCELAR'; corpo: { motivo: string }; erro?: string | null }
  | { idOperacao: string; criadaEm: string; medicaoId: string; numero: string; tipo: 'CONFERIR'; corpo: { alterou: boolean; conferidaEm: string }; erro?: string | null };

export class ErroApi extends Error {
  constructor(message: string, public status: number, public dados: Record<string, unknown> = {}) { super(message); }
}

export async function chamar<T>(caminho: string, method = 'GET', corpo?: unknown): Promise<T> {
  const r = await fetch(caminho, {
    method, credentials: 'same-origin',
    headers: corpo !== undefined ? { 'content-type': 'application/json' } : {},
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi((dados as { erro?: string }).erro ?? `Erro ${r.status}`, r.status, dados as Record<string, unknown>);
  return dados as T;
}
export const semRede = (e: unknown) => !(e instanceof ErroApi) || e.status === 503;
const novoId = () => crypto.randomUUID();
const ops = async () => (await todos<Op>('medicoesOps')).sort((a, b) => a.criadaEm.localeCompare(b.criadaEm));

/** Conferência possível com o que está no aparelho (o servidor confirma ao sincronizar). */
function conferenciaLocal(m: Medicao): Conferencia {
  if (m.statusBanco === 'CANCELADA' || m.conferidaEm || !m.vaos.length) return { pode: false, destino: 'NENHUM', explicacao: '' };
  if (m.pedidoId) {
    return m.pedidoStatus === 'CONFERENCIA_MEDIDAS'
      ? { pode: true, destino: 'PEDIDO', explicacao: `O pedido ${m.pedidoNumero} está esperando esta medição. A previsão de entrega conta a partir do dia da conferência.` }
      : { pode: true, destino: 'REGISTRO', explicacao: `O pedido ${m.pedidoNumero} já passou da conferência: fica só registrada.` };
  }
  if (m.orcamentoAtualId) return { pode: true, destino: 'ORCAMENTO', explicacao: `Orçamento ${m.orcamentoCodigo ?? ''}: se as medidas mudaram, o sistema cria a nova versão para ajustar.` };
  return { pode: true, destino: 'REGISTRO', explicacao: 'Sem orçamento ligado: as medidas aparecem no configurador quando o orçamento deste cliente for criado.' };
}

/** Junta no que veio da API o que ainda está só no aparelho (filas). */
async function comPendencias(base: Medicao): Promise<Medicao> {
  let m: Medicao = { ...base };
  const minhas = (await ops()).filter((o) => o.medicaoId === m.id);
  const reg = await ler<RegistroPendente>('medicoesPendentes', m.id);
  const fotos = (await todos<FotoPendente>('fotosPendentes')).filter((f) => f.medicaoId === m.id);
  for (const o of minhas) {
    if (o.tipo === 'REMARCAR') {
      m = { ...m, dataAgendada: o.corpo.dataAgendada, duracaoHoras: o.corpo.duracaoHoras, observacoes: o.corpo.observacoes,
        responsavelId: o.corpo.responsavelId ?? m.responsavelId, responsavelNome: o.responsavelNome ?? m.responsavelNome };
    }
  }
  if (reg) {
    m = { ...m, vaos: reg.corpo.vaos, obsCampo: reg.corpo.obsCampo, dataRealizada: reg.corpo.realizadaEm, status: 'REALIZADA', statusBanco: 'REALIZADA', statusNome: 'Medida (aguardando internet)' };
    m.conferencia = conferenciaLocal(m);
  }
  for (const o of minhas) {
    if (o.tipo === 'CANCELAR') m = { ...m, status: 'CANCELADA', statusBanco: 'CANCELADA', statusNome: 'Cancelada (aguardando internet)', motivoCancelamento: o.corpo.motivo, conferencia: { pode: false, destino: 'NENHUM', explicacao: '' } };
    if (o.tipo === 'CONFERIR') m = { ...m, status: 'CONFERIDA', statusNome: 'Conferida (aguardando internet)', conferidaEm: o.corpo.conferidaEm, conferencia: { pode: false, destino: 'NENHUM', explicacao: '' } };
  }
  const pendente = Boolean(reg || fotos.length || minhas.length);
  return {
    ...m, pendente,
    fotos: [...m.fotos, ...fotos.filter((f) => !m.fotos.some((x) => x.id === f.id)).map((f) => ({ id: f.id, vaoId: f.vaoId, legenda: f.legenda, dataUrl: f.dataUrl, pendente: true }))],
  };
}

async function idsComPendencia(): Promise<Set<string>> {
  const s = new Set<string>();
  for (const o of await todos<Op>('medicoesOps')) s.add(o.medicaoId);
  for (const r of await todos<RegistroPendente>('medicoesPendentes')) s.add(r.medicaoId);
  for (const f of await todos<FotoPendente>('fotosPendentes')) s.add(f.medicaoId);
  return s;
}

/** Baixa o pacote da obra (com internet) ou usa o que está no aparelho. */
export async function carregarPacote(): Promise<{ medicoes: Medicao[]; offline: boolean; baixadoEm: string | null }> {
  try {
    const r = await chamar<{ medicoes: Medicao[]; geradoEm: string }>('/api/medicoes/pacote-offline');
    // Mantém no aparelho as que ainda têm algo para enviar, mesmo que não venham no pacote.
    const pend = await idsComPendencia();
    const extras = (await todos<Medicao>('medicoes')).filter((l) => pend.has(l.id) && !r.medicoes.some((m) => m.id === l.id));
    await substituirTudo('medicoes', [...r.medicoes, ...extras]);
    await gravar('meta', r.geradoEm, 'medicoesBaixadasEm');
    return { medicoes: await Promise.all([...r.medicoes, ...extras].map(comPendencias)), offline: false, baixadoEm: r.geradoEm };
  } catch (e) {
    if (!semRede(e)) throw e;
    const locais = (await todos<Medicao>('medicoes')).sort((a, b) => a.dataAgendada.localeCompare(b.dataAgendada));
    return { medicoes: await Promise.all(locais.map(comPendencias)), offline: true, baixadoEm: (await ler<string>('meta', 'medicoesBaixadasEm')) ?? null };
  }
}

/** Visitas marcadas no aparelho e ainda não enviadas (a agenda online ainda não as conhece). */
export async function visitasSoNoAparelho(): Promise<Medicao[]> {
  const ag = new Set((await ops()).filter((o) => o.tipo === 'AGENDAR').map((o) => o.medicaoId));
  const locais = (await todos<Medicao>('medicoes')).filter((m) => ag.has(m.id));
  return Promise.all(locais.map(comPendencias));
}

/** Abre a medição: da API (e guarda no aparelho) ou do aparelho, sem internet. */
export async function abrirMedicao(id: string): Promise<{ medicao: Medicao | null; offline: boolean }> {
  const soLocal = (await ops()).some((o) => o.tipo === 'AGENDAR' && o.medicaoId === id);
  if (!soLocal) {
    try {
      const r = await chamar<{ medicao: Medicao }>(`/api/medicoes/${id}`);
      await gravar('medicoes', r.medicao);
      return { medicao: await comPendencias(r.medicao), offline: false };
    } catch (e) {
      if (!semRede(e)) throw e;
    }
  }
  const local = await ler<Medicao>('medicoes', id);
  return { medicao: local ? await comPendencias(local) : null, offline: !soLocal || !navigator.onLine };
}

// ------------------------------------------------------------------ marcar, remarcar, cancelar, conferir

function enderecoDe(c: Partial<Cliente>) {
  const rua = [c.logradouro, c.numero].filter(Boolean).join(' ');
  const cid = [c.cidade, c.uf].filter(Boolean).join(' - ');
  return [rua, c.complemento, c.bairro, cid].filter(Boolean).join(', ') || null;
}

/** Marca a visita. Sem internet, guarda no aparelho com os dados que o aparelho tem do cliente e do orçamento. */
export async function agendar(corpo: CorpoAgendar, info: { responsavelNome: string | null }): Promise<{ offline: boolean; id: string; avisos: string[] }> {
  try {
    const r = await chamar<{ medicao: Medicao; avisos?: string[] }>('/api/medicoes', 'POST', corpo);
    await gravar('medicoes', r.medicao);
    return { offline: false, id: r.medicao.id, avisos: r.avisos ?? [] };
  } catch (e) {
    if (!semRede(e)) throw e;
    const c = (await ler<Cliente>('clientes', corpo.clienteId)) ?? ({} as Partial<Cliente>);
    const o = corpo.orcamentoId ? await ler<Orcamento>('orcamentos', corpo.orcamentoId) : undefined;
    const local: Medicao = {
      id: corpo.id, numero: 'Nova (a enviar)', status: 'AGENDADA', statusBanco: 'AGENDADA', statusNome: 'Agendada (aguardando internet)',
      dataAgendada: corpo.dataAgendada, duracaoHoras: corpo.duracaoHoras?.replace(',', '.') ?? null, dataRealizada: null, observacoes: corpo.observacoes, obsCampo: null,
      responsavelId: corpo.responsavelId, responsavelNome: info.responsavelNome,
      clienteId: corpo.clienteId, clienteNome: c.nomeCompleto ?? 'Cliente', clienteTelefone: c.telefoneWhatsapp ?? '', endereco: enderecoDe(c), obsAcesso: c.obsAcessoInstalacao ?? null,
      orcamentoId: corpo.orcamentoId, orcamentoCodigo: o?.codigo ?? null, orcamentoAtualId: corpo.orcamentoId, orcamentoAtualVersao: o?.versao ?? null, orcamentoAtualStatus: o?.status ?? null,
      pedidoId: o?.pedidoId ?? null, pedidoNumero: o?.pedidoNumero ?? null, pedidoStatus: o?.pedidoId ? 'CONFERENCIA_MEDIDAS' : null,
      vaos: [], registradoOffline: true, conferidaEm: null, conferidaPorNome: null, orcamentoGeradoId: null, canceladaEm: null, motivoCancelamento: null,
      atualizadoEm: new Date().toISOString(), fotos: [],
      itens: (o?.itens ?? []).map((i) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, descricao: i.descricaoComercial, larguraBruta: null, alturaBruta: null, larguraProducao: i.larguraProducao ?? '0', alturaProducao: i.alturaProducao ?? '0' })),
      conferencia: { pode: false, destino: 'NENHUM', explicacao: '' },
    };
    await gravar('medicoes', local);
    await gravar('medicoesOps', { idOperacao: novoId(), criadaEm: new Date().toISOString(), medicaoId: corpo.id, numero: local.numero, tipo: 'AGENDAR', corpo } satisfies Op);
    return { offline: true, id: corpo.id, avisos: [] };
  }
}

type ResultadoAcao = { offline: boolean; medicao: Medicao | null; avisos: string[]; resultado?: { mensagem: string; orcamentoId: string | null; pedidoId: string | null } };

async function acaoOuFila(m: Medicao, tipo: 'REMARCAR' | 'CANCELAR' | 'CONFERIR', caminho: string, corpo: Op['corpo'], extra: { responsavelNome?: string | null } = {}): Promise<ResultadoAcao> {
  // Visita marcada no aparelho e ainda não enviada: a ação vai para a fila, atrás da marcação.
  const naFila = (await ops()).some((o) => o.medicaoId === m.id);
  if (!naFila) {
    try {
      const r = await chamar<{ medicao: Medicao; avisos?: string[]; resultado?: ResultadoAcao['resultado'] }>(caminho, 'POST', corpo);
      await gravar('medicoes', r.medicao);
      return { offline: false, medicao: await comPendencias(r.medicao), avisos: r.avisos ?? [], resultado: r.resultado };
    } catch (e) {
      if (!semRede(e)) throw e;
    }
  }
  await gravar('medicoesOps', { idOperacao: novoId(), criadaEm: new Date().toISOString(), medicaoId: m.id, numero: m.numero, tipo, corpo, ...extra } as Op);
  const local = await ler<Medicao>('medicoes', m.id);
  return { offline: true, medicao: local ? await comPendencias(local) : null, avisos: [] };
}

export const remarcar = (m: Medicao, corpo: Omit<CorpoRemarcar, 'atualizadoEmBase'>, responsavelNome: string | null) =>
  acaoOuFila(m, 'REMARCAR', `/api/medicoes/${m.id}/remarcar`, { ...corpo, atualizadoEmBase: m.atualizadoEm }, { responsavelNome });
export const cancelar = (m: Medicao, motivo: string) => acaoOuFila(m, 'CANCELAR', `/api/medicoes/${m.id}/cancelar`, { motivo });
export const conferir = (m: Medicao, alterou: boolean) =>
  acaoOuFila(m, 'CONFERIR', `/api/medicoes/${m.id}/conferir`, { alterou, conferidaEm: new Date().toISOString() });

// ------------------------------------------------------------------ vãos e fotos

/** Grava os vãos: envia ou, sem internet, guarda no aparelho. */
export async function registrar(m: Pick<Medicao, 'id' | 'numero'>, corpo: CorpoRegistro): Promise<{ offline: boolean; medicao: Medicao | null }> {
  const naFila = (await ops()).some((o) => o.tipo === 'AGENDAR' && o.medicaoId === m.id);
  if (!naFila) {
    try {
      const r = await chamar<{ medicao: Medicao }>(`/api/medicoes/${m.id}/registro`, 'POST', corpo);
      await apagar('medicoesPendentes', m.id);
      await gravar('medicoes', r.medicao);
      return { offline: false, medicao: await comPendencias(r.medicao) };
    } catch (e) {
      if (!semRede(e)) throw e;
    }
  }
  await gravar('medicoesPendentes', { medicaoId: m.id, numero: m.numero, corpo: { ...corpo, offline: true }, erro: null } satisfies RegistroPendente);
  const local = await ler<Medicao>('medicoes', m.id);
  return { offline: true, medicao: local ? await comPendencias(local) : null };
}

/** Foto do vão: envia ou guarda no aparelho. */
export async function adicionarFoto(m: Pick<Medicao, 'id' | 'numero'>, f: { id: string; vaoId: string | null; legenda: string | null; dataUrl: string }): Promise<{ offline: boolean }> {
  const naFila = (await ops()).some((o) => o.tipo === 'AGENDAR' && o.medicaoId === m.id);
  if (!naFila) {
    try {
      await chamar(`/api/medicoes/${m.id}/fotos`, 'POST', f);
      return { offline: false };
    } catch (e) {
      if (!semRede(e)) throw e;
    }
  }
  await gravar('fotosPendentes', { ...f, medicaoId: m.id, numero: m.numero, erro: null } satisfies FotoPendente);
  return { offline: true };
}

export async function removerFoto(medicaoId: string, fotoId: string, pendente: boolean) {
  if (pendente) { await apagar('fotosPendentes', fotoId); return; }
  await chamar(`/api/medicoes/${medicaoId}/fotos/${fotoId}`, 'DELETE');
}

// ------------------------------------------------------------------ envio do que ficou no aparelho

let enviando: Promise<{ enviados: number; recusados: string[]; avisos: string[] }> | null = null;

export function enviarPendentes() {
  if (enviando) return enviando;
  enviando = (async () => {
    const res = { enviados: 0, recusados: [] as string[], avisos: [] as string[] };
    // Cliente cadastrado sem internet precisa existir no servidor antes da visita dele.
    await enviarClientes().catch(() => null);
    const falhou = new Set<string>(); // visitas cuja marcação não foi aceita: o resto delas espera

    for (const o of (await ops()).filter((x) => x.tipo === 'AGENDAR')) {
      try {
        const r = await chamar<{ medicao: Medicao; avisos?: string[] }>('/api/medicoes', 'POST', o.corpo);
        await apagar('medicoesOps', o.idOperacao);
        await gravar('medicoes', r.medicao);
        res.avisos.push(...(r.avisos ?? []));
        res.enviados++;
      } catch (e) {
        if (semRede(e)) return res;
        falhou.add(o.medicaoId);
        await gravar('medicoesOps', { ...o, erro: (e as Error).message });
        res.recusados.push(`Visita marcada sem internet: ${(e as Error).message}`);
      }
    }
    for (const r of await todos<RegistroPendente>('medicoesPendentes')) {
      if (falhou.has(r.medicaoId)) continue;
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
      if (falhou.has(f.medicaoId)) continue;
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
    const pendReg = new Set((await todos<RegistroPendente>('medicoesPendentes')).map((r) => r.medicaoId));
    for (const o of (await ops()).filter((x) => x.tipo !== 'AGENDAR')) {
      if (falhou.has(o.medicaoId) || (o.tipo === 'CONFERIR' && pendReg.has(o.medicaoId))) continue;
      const caminho = `/api/medicoes/${o.medicaoId}/${o.tipo === 'REMARCAR' ? 'remarcar' : o.tipo === 'CANCELAR' ? 'cancelar' : 'conferir'}`;
      const m = await ler<Medicao>('medicoes', o.medicaoId);
      const nome = m ? `${m.numero} (${m.clienteNome})` : o.numero;
      try {
        const r = await chamar<{ medicao: Medicao; avisos?: string[]; resultado?: { mensagem: string } }>(caminho, 'POST', o.corpo);
        await gravar('medicoes', r.medicao);
        if (r.resultado) res.avisos.push(`${nome}: ${r.resultado.mensagem}`);
        res.avisos.push(...(r.avisos ?? []));
        res.enviados++;
      } catch (e) {
        if (semRede(e)) return res;
        // Conflito: vale o que está no servidor; a mudança feita sem internet é descartada com aviso.
        if (e instanceof ErroApi && e.dados.jaConferida) res.avisos.push(`${nome}: já tinha sido conferida por outra pessoa.`);
        else res.recusados.push(`${nome}: ${(e as Error).message}`);
      }
      await apagar('medicoesOps', o.idOperacao);
    }
    return res;
  })().finally(() => { enviando = null; });
  return enviando;
}

export async function contarPendentes(): Promise<number> {
  return (await todos('medicoesPendentes')).length + (await todos('fotosPendentes')).length + (await todos('medicoesOps')).length;
}

// ------------------------------------------------------------------ fotos e medidas

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

export type Leitura = { metros: string; regra: 'metros' | 'centímetros' | 'milímetros' };

/**
 * Lê a medida digitada em metros, centímetros ou milímetros (decisão do Gabriel, 27/11/2026).
 * Medida de vão (largura/altura):
 *   - com vírgula ou ponto: até 20 = metros (2,595 = 2,595 m); acima de 20 = centímetros (259,5 = 2,595 m)
 *   - número inteiro: 1 a 9 = metros (3 = 3 m); 10 a 999 = centímetros (260 = 2,60 m); 1000 ou mais = milímetros (2595 = 2,595 m)
 * Profundidade do cortineiro: inteiro até 200 = centímetros (15 = 0,15 m); acima = milímetros; com vírgula até 2 = metros.
 */
export function interpretarMedida(texto: string, tipo: 'VAO' | 'PROFUNDIDADE' = 'VAO'): Leitura | null {
  let t = texto.trim().replace(/\s/g, '').replace(/m$/i, '');
  if (!t) return null;
  const temSeparador = /[.,]/.test(t);
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '');
  t = t.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!(n > 0)) return null;
  const fmt = (v: number) => String(Math.round(v * 10000) / 10000);
  if (temSeparador) {
    const limite = tipo === 'VAO' ? 20 : 2;
    return n <= limite ? { metros: fmt(n), regra: 'metros' } : { metros: fmt(n / 100), regra: 'centímetros' };
  }
  if (tipo === 'PROFUNDIDADE') return n <= 200 ? { metros: fmt(n / 100), regra: 'centímetros' } : { metros: fmt(n / 1000), regra: 'milímetros' };
  if (n < 10) return { metros: fmt(n), regra: 'metros' };
  if (n < 1000) return { metros: fmt(n / 100), regra: 'centímetros' };
  return { metros: fmt(n / 1000), regra: 'milímetros' };
}

/** Metros com 2 casas, ou 3 quando há meio centímetro (2,595 m). */
export const metrosTxt = (v: string | null | undefined) => {
  if (!v) return '-';
  const n = Number(v);
  const casas = Math.abs(n * 100 - Math.round(n * 100)) > 1e-6 ? 3 : 2;
  return `${n.toFixed(casas).replace('.', ',')} m`;
};
/** Valor salvo (metros) de volta para o campo, em metros com vírgula. */
export const metrosParaCampo = (v: string | null | undefined) => (v ? metrosTxt(v).replace(' m', '') : '');
