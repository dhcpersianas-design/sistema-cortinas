'use client';
/**
 * Clientes com uso offline (requisito do Gabriel: o app funciona na obra sem internet).
 * - Com internet: baixa o pacote de clientes do vendedor e guarda no aparelho.
 * - Sem internet: busca no aparelho e grava cadastro/edição numa fila local.
 * - Quando a conexão volta: envia a fila. O cadastro já nasce com UUID (o
 *   servidor não duplica se receber duas vezes). Edição feita em cima de uma
 *   versão antiga é recusada pelo servidor (409) e o vendedor é avisado.
 */
import { apagar, gravar, ler, substituirTudo, todos } from './offline-db';
import { semAcento } from './texto';

export type Cliente = {
  id: string; nomeCompleto: string; tipoPessoa: 'PF' | 'PJ' | null; cpfCnpj: string | null; cpfCnpjFormatado: string;
  telefoneWhatsapp: string; telefoneFormatado: string; whatsappLink: string | null; telefoneSecundario: string | null;
  email: string | null; origemLead: string | null; cep: string | null; logradouro: string | null; numero: string | null;
  complemento: string | null; bairro: string | null; cidade: string | null; uf: string | null; tipoImovel: string | null;
  obsAcessoInstalacao: string | null; observacoes: string | null; ativo: boolean | null;
  vendedorResponsavelId: string | null; vendedorResponsavelNome: string | null;
  dataRegistro: string | null; ultimaCompraEm: string | null; ultimaInstalacaoEm: string | null; atualizadoEm: string;
  /** Só no aparelho: gravado offline e ainda não enviado. */
  pendente?: boolean;
};

export type DadosCliente = Record<string, string | boolean | null | undefined>;

type Operacao = {
  idOperacao: string; criadaEm: string;
  tipo: 'criar' | 'editar'; clienteId: string; corpo: DadosCliente & { atualizadoEmBase?: string };
};

export class ErroApi extends Error {
  constructor(message: string, public status: number, public dados: Record<string, unknown>) { super(message); }
}

async function chamar<T>(caminho: string, method = 'GET', corpo?: unknown): Promise<T> {
  const r = await fetch(caminho, {
    method, credentials: 'same-origin',
    headers: corpo !== undefined ? { 'content-type': 'application/json' } : {},
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi((dados as { erro?: string }).erro ?? `Erro ${r.status}`, r.status, dados);
  return dados as T;
}

/** Falha de rede (sem internet), diferente de erro devolvido pela API. */
const semRede = (e: unknown) => !(e instanceof ErroApi);

const uuid = () => crypto.randomUUID();

// ------------------------------------------------------------------ leitura

export async function baixarPacote(): Promise<number> {
  const { clientes, geradoEm } = await chamar<{ clientes: Cliente[]; geradoEm: string }>('/api/clientes/pacote-offline');
  // O que ainda está na fila continua valendo por cima do pacote.
  const fila = await todos<Operacao>('fila');
  const locais = new Map((await todos<Cliente>('clientes')).filter((c) => c.pendente).map((c) => [c.id, c]));
  const final = new Map(clientes.map((c) => [c.id, c]));
  for (const op of fila) { const l = locais.get(op.clienteId); if (l) final.set(l.id, l); }
  await substituirTudo('clientes', [...final.values()]);
  await gravar('meta', geradoEm, 'clientesBaixadosEm');
  return clientes.length;
}

/** Busca no aparelho: mesma ideia da API (sem acento; nome, telefone, CPF, e-mail, bairro, cidade). */
export async function buscarLocal(q: string, limite = 50): Promise<Cliente[]> {
  const lista = (await todos<Cliente>('clientes')).filter((c) => c.ativo !== false);
  const termo = semAcento(q.trim());
  const dig = q.replace(/\D/g, '');
  const achou = !termo ? lista : lista.filter((c) =>
    semAcento([c.nomeCompleto, c.email, c.bairro, c.cidade].filter(Boolean).join(' ')).includes(termo)
    || (dig.length >= 4 && ((c.telefoneWhatsapp ?? '').replace(/\D/g, '').includes(dig)
      || (c.telefoneSecundario ?? '').replace(/\D/g, '').includes(dig) || (c.cpfCnpj ?? '').startsWith(dig))));
  return achou.sort((a, b) => semAcento(a.nomeCompleto).localeCompare(semAcento(b.nomeCompleto))).slice(0, limite);
}

export async function buscar(q: string): Promise<{ clientes: Cliente[]; offline: boolean }> {
  try {
    const { clientes } = await chamar<{ clientes: Cliente[] }>(`/api/clientes?q=${encodeURIComponent(q)}`);
    // Pendentes do aparelho também aparecem
    const pendentes = (await buscarLocal(q)).filter((c) => c.pendente && !clientes.some((x) => x.id === c.id));
    return { clientes: [...pendentes, ...clientes], offline: false };
  } catch (e) {
    if (!semRede(e)) throw e;
    return { clientes: await buscarLocal(q), offline: true };
  }
}

export type Ficha = {
  cliente: Cliente;
  historico: {
    pedidos: { pedidoId: string; numeroPedido: string; dataCompra: string; dataInstalacao: string | null; formaPagamento: string | null; valorTotal: string; status: string; produtos: string | null }[];
    instalacoes: { pedidoId: string; numeroPedido: string; dataInstalacao: string; produtos: string | null }[];
    orcamentos: { id: string; codigo: string; versao: number; status: string; dataCriacao: string; valorTotal: string }[];
  } | null;
};

export async function abrirFicha(id: string): Promise<Ficha | null> {
  const local = await ler<Cliente>('clientes', id);
  if (local?.pendente) return { cliente: local, historico: null };
  try {
    const f = await chamar<Ficha>(`/api/clientes/${id}`);
    await gravar('clientes', f.cliente);
    return f;
  } catch (e) {
    if (!semRede(e)) { if ((e as ErroApi).status === 404) return null; throw e; }
    return local ? { cliente: local, historico: null } : null;
  }
}

// ------------------------------------------------------------------ gravação

/** Versão local enquanto não sincroniza (o servidor normaliza telefone/CPF depois). */
function rascunhoLocal(base: Partial<Cliente>, corpo: DadosCliente): Cliente {
  const v = (k: string) => (corpo[k] === undefined ? (base as Record<string, unknown>)[k] : corpo[k] || null) as string | null;
  const doc = typeof corpo.documento === 'string' ? corpo.documento : undefined;
  return {
    ...(base as Cliente),
    nomeCompleto: v('nomeCompleto') ?? '',
    telefoneWhatsapp: v('telefoneWhatsapp') ?? '',
    telefoneFormatado: v('telefoneWhatsapp') ?? '',
    telefoneSecundario: v('telefoneSecundario'), email: v('email'), origemLead: v('origemLead'),
    cep: v('cep'), logradouro: v('logradouro'), numero: v('numero'), complemento: v('complemento'),
    bairro: v('bairro'), cidade: v('cidade'), uf: v('uf'), tipoImovel: v('tipoImovel'),
    obsAcessoInstalacao: v('obsAcessoInstalacao'), observacoes: v('observacoes'),
    cpfCnpj: doc === undefined ? (base.cpfCnpj ?? null) : doc.replace(/\D/g, '') || null,
    cpfCnpjFormatado: doc === undefined ? (base.cpfCnpjFormatado ?? '') : doc,
    ativo: typeof corpo.ativo === 'boolean' ? corpo.ativo : (base.ativo ?? true),
    pendente: true,
  };
}

export type ResultadoGravacao = { cliente: Cliente; offline: boolean; avisos: string[] };

export async function criarCliente(corpo: DadosCliente): Promise<ResultadoGravacao> {
  const id = uuid();
  try {
    const r = await chamar<{ cliente: Cliente; avisos: string[] }>('/api/clientes', 'POST', { ...corpo, id });
    await gravar('clientes', r.cliente);
    return { cliente: r.cliente, offline: false, avisos: r.avisos };
  } catch (e) {
    if (!semRede(e)) throw e;
    const local = rascunhoLocal({ id, tipoPessoa: null, whatsappLink: null, vendedorResponsavelId: null, vendedorResponsavelNome: null,
      dataRegistro: new Date().toISOString(), ultimaCompraEm: null, ultimaInstalacaoEm: null, atualizadoEm: new Date().toISOString() }, corpo);
    await gravar('clientes', local);
    await gravar('fila', { idOperacao: uuid(), criadaEm: new Date().toISOString(), tipo: 'criar', clienteId: id, corpo: { ...corpo, id } } satisfies Operacao);
    return { cliente: local, offline: true, avisos: ['Sem internet: cadastro guardado no aparelho e enviado quando a conexão voltar.'] };
  }
}

export async function editarCliente(atual: Cliente, corpo: DadosCliente): Promise<ResultadoGravacao> {
  const fila = await todos<Operacao>('fila');
  const criacaoPendente = fila.find((o) => o.tipo === 'criar' && o.clienteId === atual.id);
  if (criacaoPendente) {
    // Ainda não chegou ao servidor: junta na própria criação.
    criacaoPendente.corpo = { ...criacaoPendente.corpo, ...corpo };
    await gravar('fila', criacaoPendente);
    const local = rascunhoLocal(atual, corpo);
    await gravar('clientes', local);
    return { cliente: local, offline: true, avisos: ['Alteração guardada no aparelho.'] };
  }
  const comBase = { ...corpo, atualizadoEmBase: atual.atualizadoEm };
  try {
    const r = await chamar<{ cliente: Cliente; avisos: string[] }>(`/api/clientes/${atual.id}`, 'PATCH', comBase);
    await gravar('clientes', r.cliente);
    return { cliente: r.cliente, offline: false, avisos: r.avisos };
  } catch (e) {
    if (!semRede(e)) throw e;
    const local = rascunhoLocal(atual, corpo);
    await gravar('clientes', local);
    await gravar('fila', { idOperacao: uuid(), criadaEm: new Date().toISOString(), tipo: 'editar', clienteId: atual.id, corpo: comBase } satisfies Operacao);
    return { cliente: local, offline: true, avisos: ['Sem internet: alteração guardada no aparelho e enviada quando a conexão voltar.'] };
  }
}

// ------------------------------------------------------------------ sincronização

export type ResultadoEnvio = { enviados: number; recusados: string[]; pendentes: number };

let enviando: Promise<ResultadoEnvio> | null = null;

/** Envia a fila em ordem. Para no primeiro erro de rede (tenta de novo depois). */
export function enviarFila(): Promise<ResultadoEnvio> {
  if (enviando) return enviando;
  enviando = (async () => {
    const fila = (await todos<Operacao>('fila')).sort((a, b) => a.criadaEm.localeCompare(b.criadaEm));
    let enviados = 0;
    const recusados: string[] = [];
    for (const op of fila) {
      try {
        const r = op.tipo === 'criar'
          ? await chamar<{ cliente: Cliente }>('/api/clientes', 'POST', op.corpo)
          : await chamar<{ cliente: Cliente }>(`/api/clientes/${op.clienteId}`, 'PATCH', op.corpo);
        if (r.cliente) await gravar('clientes', r.cliente);
        await apagar('fila', op.idOperacao);
        enviados++;
      } catch (e) {
        if (semRede(e)) break;
        // Recusado pelo servidor (dado inválido, CPF repetido, conflito): sai da fila e avisa.
        const err = e as ErroApi;
        const nome = String(op.corpo.nomeCompleto ?? (await ler<Cliente>('clientes', op.clienteId))?.nomeCompleto ?? 'cliente');
        recusados.push(`${nome}: ${err.message}`);
        const doServidor = err.dados.cliente as Cliente | undefined;
        if (doServidor) await gravar('clientes', doServidor);
        else if (op.tipo === 'criar') await apagar('clientes', op.clienteId);
        await apagar('fila', op.idOperacao);
      }
    }
    if (recusados.length) {
      const antigos = (await ler<string[]>('meta', 'recusados')) ?? [];
      await gravar('meta', [...antigos, ...recusados].slice(-20), 'recusados');
    }
    return { enviados, recusados, pendentes: (await todos('fila')).length };
  })().finally(() => { enviando = null; });
  return enviando;
}

export async function contarPendentes(): Promise<number> {
  return (await todos('fila')).length;
}

export async function lerRecusados(): Promise<string[]> {
  return (await ler<string[]>('meta', 'recusados')) ?? [];
}

export async function limparRecusados(): Promise<void> {
  await apagar('meta', 'recusados');
}
