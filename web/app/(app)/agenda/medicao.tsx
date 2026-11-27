'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect, classeTextarea, Mensagens } from '@/components/cadastro/campos';
import {
  abrirMedicao, adicionarFoto, chamar, cmParaMetros, ErroApi, metrosParaCm, metrosTxt, reduzirFoto, registrar, removerFoto,
  type FotoInfo, type ItemOrcamento, type Medicao, type Vao,
} from '@/lib/medicoes-offline';
import { dataHoraBR, isoParaLocal, localParaIso, STATUS_PEDIDO } from '../pedidos/formato';

/** Vão no formulário: medidas em centímetros, como o vendedor digita na obra. */
type VaoForm = Omit<Vao, 'larguras' | 'alturas' | 'profundidadeCortineiroM'> & { larguras: string[]; alturas: string[]; profundidade: string };

const MODOS: [string, string][] = [['DENTRO_VAO', 'Dentro do vão (embutida)'], ['FORA_VAO', 'Fora do vão (parede)'], ['TETO', 'No teto / cortineiro']];
const nomeModo = (m: string | null) => MODOS.find((x) => x[0] === m)?.[1] ?? '';

function vaoParaForm(v: Vao): VaoForm {
  const { profundidadeCortineiroM, ...resto } = v;
  return {
    ...resto,
    larguras: [0, 1, 2].map((i) => metrosParaCm(v.larguras[i])),
    alturas: [0, 1, 2].map((i) => metrosParaCm(v.alturas[i])),
    profundidade: metrosParaCm(profundidadeCortineiroM),
  };
}
function vaoNovo(item?: ItemOrcamento): VaoForm {
  return {
    id: crypto.randomUUID().slice(0, 8), ambiente: item?.ambiente ?? '', descricao: item?.descricao ?? '',
    tipo: item?.tipo === 'PERSIANA' ? 'PERSIANA' : 'CORTINA', modo: item?.tipo === 'PERSIANA' ? 'DENTRO_VAO' : null,
    larguras: ['', '', ''], alturas: ['', '', ''], ladoComando: null, profundidade: '', observacoes: null, itemId: item?.id ?? null,
  };
}

/** Confere e converte o formulário (cm) para o registro (m). Devolve o erro em texto. */
function formParaVao(f: VaoForm, n: number): Vao | string {
  const rot = `Vão ${n} (${f.ambiente || 'sem ambiente'})`;
  if (!f.ambiente.trim()) return `${rot}: informe o ambiente.`;
  const conv = (lista: string[], nome: string) => {
    const out: string[] = [];
    for (const v of lista) {
      if (!v.trim()) continue;
      const m = cmParaMetros(v);
      if (!m) return `${rot}: ${nome} inválida ("${v}").`;
      if (Number(m) < 0.1) return `${rot}: ${nome} de ${v} cm é pequena demais. Digite em centímetros (ex.: 260).`;
      out.push(m);
    }
    return out.length ? out : `${rot}: informe a ${nome}.`;
  };
  const l = conv(f.tipo === 'CORTINA' ? f.larguras.slice(0, 1) : f.larguras, 'largura');
  if (typeof l === 'string') return l;
  const a = conv(f.tipo === 'CORTINA' ? f.alturas.slice(0, 1) : f.alturas, 'altura');
  if (typeof a === 'string') return a;
  if (l.some((x) => Number(x) > 15)) return `${rot}: largura acima de 15 m. Confira se digitou em centímetros.`;
  if (a.some((x) => Number(x) > 10)) return `${rot}: altura acima de 10 m. Confira se digitou em centímetros.`;
  const prof = f.profundidade.trim() ? cmParaMetros(f.profundidade) : null;
  if (f.profundidade.trim() && !prof) return `${rot}: profundidade inválida.`;
  return {
    id: f.id, ambiente: f.ambiente.trim(), descricao: f.descricao.trim(), tipo: f.tipo, modo: f.tipo === 'PERSIANA' ? (f.modo ?? 'DENTRO_VAO') : null,
    larguras: l, alturas: a, ladoComando: f.ladoComando, profundidadeCortineiroM: f.tipo === 'CORTINA' ? prof : null,
    observacoes: f.observacoes?.trim() || null, itemId: f.itemId,
  };
}

/** Resumo do vão medido (para conferência e leitura). Persiana dentro do vão: vale a MENOR medida. */
export function resumoVao(v: Vao) {
  const lista = (xs: string[]) => xs.map((x) => metrosTxt(x)).join(' / ');
  if (v.tipo === 'CORTINA') {
    return `Trilho ${metrosTxt(v.larguras[0])} x altura ${metrosTxt(v.alturas[0])}${v.profundidadeCortineiroM ? ` · cortineiro ${metrosTxt(v.profundidadeCortineiroM)}` : ''}`;
  }
  const menor = (xs: string[]) => metrosTxt(String(Math.min(...xs.map(Number))));
  return `${nomeModo(v.modo)} · largura ${lista(v.larguras)}${v.larguras.length > 1 ? ` (menor ${menor(v.larguras)})` : ''} · altura ${lista(v.alturas)}${v.alturas.length > 1 ? ` (menor ${menor(v.alturas)})` : ''}${v.ladoComando ? ` · comando ${v.ladoComando === 'DIREITO' ? 'direito' : 'esquerdo'}` : ''}`;
}

export function corMedicao(s: string) {
  if (s === 'CONFERIDA') return 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  if (s === 'REALIZADA') return 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400';
  if (s === 'CANCELADA') return 'text-muted-foreground line-through';
  return 'border-violet-500/50 bg-violet-500/10 text-violet-700 dark:text-violet-400';
}

/** +5511966662222 -> (11) 96666-2222 */
function telefone(t: string) {
  const n = t.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return t;
}

const fotoSrc = (f: FotoInfo) => f.dataUrl ?? `/api/medicoes/fotos/${f.id}`;

export function TelaMedicao({ id, admin, vendedores, onVoltar, onMudou }: {
  id: string; admin: boolean; vendedores: { id: string; nome: string }[]; onVoltar: () => void; onMudou: () => void;
}) {
  const [m, setM] = useState<Medicao | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [vaos, setVaos] = useState<VaoForm[]>([]);
  const [obsCampo, setObsCampo] = useState('');
  const [editando, setEditando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [remarcar, setRemarcar] = useState<{ quando: string; duracao: string; responsavelId: string; obs: string } | null>(null);
  const [cancelar, setCancelar] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ mensagem: string; orcamentoId: string | null; pedidoId: string | null } | null>(null);
  const [fotoGrande, setFotoGrande] = useState<FotoInfo | null>(null);

  const aplicar = useCallback((x: Medicao | null) => {
    setM(x);
    if (!x) return;
    setVaos(x.vaos.length ? x.vaos.map(vaoParaForm) : []);
    setObsCampo(x.obsCampo ?? '');
    setEditando(x.statusBanco === 'AGENDADA' && !x.pendente && !x.vaos.length);
  }, []);

  const carregar = useCallback(async () => {
    try {
      const r = await abrirMedicao(id);
      setOffline(r.offline);
      aplicar(r.medicao);
    } catch (e) { setErro((e as Error).message); setM(null); }
  }, [id, aplicar]);
  useEffect(() => { carregar(); }, [carregar]);

  if (m === undefined) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (!m) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onVoltar}>← Agenda</Button>
        <Mensagens erro={erro ?? 'Medição não encontrada no aparelho. Com internet, abra a Agenda para baixar as suas visitas.'} />
      </div>
    );
  }

  const fechada = Boolean(m.conferidaEm) || m.statusBanco === 'CANCELADA';
  const podeEditar = !fechada;

  async function acao<T>(caminho: string, corpo: unknown, msg: string): Promise<T | null> {
    setErro(null); setOk(null); setAvisos([]); setSalvando(true);
    try {
      const r = await chamar<T & { medicao: Medicao; avisos?: string[] }>(caminho, 'POST', corpo);
      aplicar(r.medicao);
      setOk(msg);
      setAvisos(r.avisos ?? []);
      onMudou();
      return r;
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Sem internet: esta ação precisa de conexão.');
      return null;
    } finally { setSalvando(false); }
  }

  async function salvarVaos() {
    const convertidos: Vao[] = [];
    for (const [i, f] of vaos.entries()) {
      const v = formParaVao(f, i + 1);
      if (typeof v === 'string') { setErro(v); return; }
      convertidos.push(v);
    }
    if (!convertidos.length) { setErro('Adicione ao menos um vão.'); return; }
    setErro(null); setOk(null); setSalvando(true);
    try {
      const r = await registrar(m!, { registroId: crypto.randomUUID(), vaos: convertidos, obsCampo: obsCampo.trim() || null, realizadaEm: new Date().toISOString() });
      if (r.medicao) aplicar(r.medicao);
      setEditando(false);
      setOk(r.offline ? 'Sem internet: a medição ficou guardada no aparelho e será enviada quando a conexão voltar.' : 'Medição registrada. Agora confira as medidas.');
      onMudou();
    } catch (e) { setErro((e as Error).message); }
    setSalvando(false);
  }

  async function fotos(arquivos: FileList | null, vaoId: string | null) {
    if (!arquivos?.length) return;
    setErro(null); setSalvando(true);
    let guardadas = 0;
    try {
      for (const a of Array.from(arquivos)) {
        const dataUrl = await reduzirFoto(a);
        const vao = vaos.find((v) => v.id === vaoId);
        const r = await adicionarFoto(m!, { id: crypto.randomUUID(), vaoId, legenda: vao ? `${vao.ambiente} ${vao.descricao}`.trim().slice(0, 120) : null, dataUrl });
        if (r.offline) guardadas++;
      }
      setOk(guardadas ? `${guardadas} foto(s) guardada(s) no aparelho; serão enviadas quando a internet voltar.` : 'Foto(s) enviada(s).');
      const r = await abrirMedicao(m!.id);
      if (r.medicao) setM({ ...r.medicao });
      onMudou();
    } catch (e) { setErro((e as Error).message); }
    setSalvando(false);
  }

  async function tirarFoto(f: FotoInfo) {
    try {
      await removerFoto(m!.id, f.id, Boolean(f.pendente));
      const r = await abrirMedicao(m!.id);
      if (r.medicao) setM({ ...r.medicao });
      onMudou();
    } catch (e) { setErro(e instanceof ErroApi ? e.message : 'Sem internet: apagar foto enviada precisa de conexão.'); }
  }

  const mudarVao = (i: number, mud: Partial<VaoForm>) => setVaos(vaos.map((v, j) => (j === i ? { ...v, ...mud } : v)));
  const mapa = m.endereco ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.endereco)}` : null;
  const fotosDo = (vaoId: string | null) => m.fotos.filter((f) => f.vaoId === vaoId || (vaoId === null && !vaos.some((v) => v.id === f.vaoId)));
  const itemDe = (v: Vao) => m.itens.find((i) => i.id === v.itemId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onVoltar}>← Agenda</Button>
        <h1 className="text-xl font-semibold">{m.clienteNome}</h1>
        <Badge>{m.numero}</Badge>
        <Badge className={corMedicao(m.status)}>{m.statusNome}</Badge>
      </div>
      {offline && <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">Sem internet: dá para medir e tirar fotos. Remarcar e conferir precisam de conexão.</p>}
      <Mensagens erro={erro} ok={ok} avisos={avisos} />

      <Card>
        <CardContent className="space-y-1 pt-4 text-sm">
          <p><strong>{dataHoraBR(m.dataAgendada)}</strong>{m.duracaoHoras ? ` · ${m.duracaoHoras.replace('.', ',')} h` : ''}{m.responsavelNome ? ` · mede: ${m.responsavelNome}` : ''}</p>
          <p>{m.endereco ?? 'Endereço não informado'} {mapa && <a className="underline" href={mapa} target="_blank" rel="noopener">mapa</a>}</p>
          <p><a className="underline" href={`tel:${m.clienteTelefone}`}>{telefone(m.clienteTelefone)}</a></p>
          {m.obsAcesso && <p className="text-amber-700 dark:text-amber-400">Acesso/condomínio: {m.obsAcesso}</p>}
          {m.observacoes && <p>Observações: {m.observacoes}</p>}
          {m.pedidoNumero
            ? <p>Pedido: {offline ? m.pedidoNumero : <a className="underline" href={`/pedidos?p=${m.pedidoId}`}>{m.pedidoNumero}</a>} ({STATUS_PEDIDO[m.pedidoStatus ?? ''] ?? m.pedidoStatus})</p>
            : m.orcamentoCodigo
              ? <p>Orçamento: {offline ? `${m.orcamentoCodigo} v${m.orcamentoAtualVersao}` : <a className="underline" href={`/orcamentos?o=${m.orcamentoAtualId}`}>{m.orcamentoCodigo} v{m.orcamentoAtualVersao}</a>}</p>
              : <p className="text-muted-foreground">Sem orçamento ligado (visita antes do orçamento).</p>}
          {m.statusBanco === 'CANCELADA' && <p className="text-destructive">Cancelada: {m.motivoCancelamento}</p>}
          {m.conferidaEm && <p className="text-emerald-700 dark:text-emerald-400">Conferida em {dataHoraBR(m.conferidaEm)}{m.conferidaPorNome ? ` por ${m.conferidaPorNome}` : ''}.</p>}
          {m.statusBanco === 'AGENDADA' && !offline && !m.pendente && !remarcar && cancelar === null && (
            <div className="flex flex-wrap gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setRemarcar({ quando: isoParaLocal(m.dataAgendada), duracao: m.duracaoHoras?.replace('.', ',') ?? '', responsavelId: m.responsavelId ?? '', obs: m.observacoes ?? '' })}>Remarcar</Button>
              <Button size="sm" variant="outline" onClick={() => setCancelar('')}>Cancelar visita</Button>
            </div>
          )}
          {remarcar && (
            <div className="space-y-2 border-t pt-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="flex flex-col gap-1 sm:col-span-2">Novo dia e hora<Input type="datetime-local" value={remarcar.quando} onChange={(e) => setRemarcar({ ...remarcar, quando: e.target.value })} /></label>
                <label className="flex flex-col gap-1">Duração (h)<Input inputMode="decimal" value={remarcar.duracao} onChange={(e) => setRemarcar({ ...remarcar, duracao: e.target.value })} /></label>
              </div>
              {admin && (
                <label className="flex flex-col gap-1">Quem vai medir
                  <select className={classeSelect} value={remarcar.responsavelId} onChange={(e) => setRemarcar({ ...remarcar, responsavelId: e.target.value })}>
                    {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1">Observações<textarea className={classeTextarea} value={remarcar.obs} onChange={(e) => setRemarcar({ ...remarcar, obs: e.target.value })} /></label>
              <div className="flex gap-2">
                <Button size="sm" disabled={salvando} onClick={async () => {
                  const r = await acao('/api/medicoes/' + m.id + '/remarcar', { dataAgendada: localParaIso(remarcar.quando), duracaoHoras: remarcar.duracao || null, responsavelId: remarcar.responsavelId || null, observacoes: remarcar.obs.trim() || null }, 'Visita remarcada.');
                  if (r) setRemarcar(null);
                }}>Salvar</Button>
                <Button size="sm" variant="outline" onClick={() => setRemarcar(null)}>Voltar</Button>
              </div>
            </div>
          )}
          {cancelar !== null && (
            <div className="space-y-2 border-t pt-3">
              <label className="flex flex-col gap-1">Motivo do cancelamento<Input value={cancelar} onChange={(e) => setCancelar(e.target.value)} /></label>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={salvando} onClick={async () => { const r = await acao(`/api/medicoes/${m.id}/cancelar`, { motivo: cancelar }, 'Visita cancelada.'); if (r) setCancelar(null); }}>Cancelar visita</Button>
                <Button size="sm" variant="outline" onClick={() => setCancelar(null)}>Voltar</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* --------------------------------------------------------- vãos */}
      {m.statusBanco !== 'CANCELADA' && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="flex-1">Vãos medidos</CardTitle>
              {podeEditar && !editando && <Button size="sm" variant="outline" onClick={() => { setEditando(true); setOk(null); }}>{m.vaos.length ? 'Corrigir medidas' : 'Começar a medir'}</Button>}
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!editando && !m.vaos.length && <p className="text-muted-foreground">Nenhum vão registrado ainda.</p>}
            {!editando && m.vaos.map((v, i) => {
              const it = itemDe(v);
              return (
                <div key={v.id} className="space-y-1 border-t pt-2">
                  <p><span className="font-medium">{i + 1}. {v.ambiente}</span>{v.descricao ? `: ${v.descricao}` : ''} <Badge>{v.tipo === 'CORTINA' ? 'Cortina' : 'Persiana'}</Badge></p>
                  <p>{resumoVao(v)}</p>
                  {it && <p className="text-xs text-muted-foreground">No orçamento: {it.larguraBruta ? `${metrosTxt(it.larguraBruta)} x ${metrosTxt(it.alturaBruta)}` : `${metrosTxt(it.larguraProducao)} x ${metrosTxt(it.alturaProducao)}`} ({it.descricao})</p>}
                  {v.observacoes && <p className="text-muted-foreground">{v.observacoes}</p>}
                  <Fotos lista={fotosDo(v.id)} podeTirar={podeEditar} onAbrir={setFotoGrande} onTirar={tirarFoto} />
                  {podeEditar && <FotoBotao rotulo="Foto deste vão" disabled={salvando} onFotos={(f) => fotos(f, v.id)} />}
                </div>
              );
            })}
            {!editando && m.obsCampo && <p className="border-t pt-2">Anotações: {m.obsCampo}</p>}

            {editando && (
              <>
                <p className="text-muted-foreground">Digite as medidas em <strong>centímetros</strong> (ex.: 260). Persiana dentro do vão: meça em 3 pontos; vale a menor.</p>
                {vaos.length === 0 && m.itens.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => setVaos(m.itens.map((it) => vaoNovo(it)))}>Trazer os {m.itens.length} itens do orçamento</Button>
                )}
                {vaos.map((v, i) => (
                  <div key={v.id} className="space-y-2 rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Vão {i + 1}</span>
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setVaos(vaos.filter((_, j) => j !== i))}>Remover</Button>
                    </div>
                    {m.itens.length > 0 && (
                      <label className="flex flex-col gap-1">Item do orçamento
                        <select className={classeSelect} value={v.itemId ?? ''} onChange={(e) => {
                          const it = m.itens.find((x) => x.id === e.target.value);
                          mudarVao(i, it ? { itemId: it.id, ambiente: v.ambiente || it.ambiente, descricao: v.descricao || it.descricao, tipo: it.tipo === 'PERSIANA' ? 'PERSIANA' : 'CORTINA', modo: it.tipo === 'PERSIANA' ? (v.modo ?? 'DENTRO_VAO') : null } : { itemId: null });
                        }}>
                          <option value="">Nenhum (vão novo)</option>
                          {m.itens.map((it) => <option key={it.id} value={it.id}>{it.ambiente}: {it.descricao}</option>)}
                        </select>
                      </label>
                    )}
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="flex flex-col gap-1">Ambiente<Input value={v.ambiente} placeholder="Sala" onChange={(e) => mudarVao(i, { ambiente: e.target.value })} /></label>
                      <label className="flex flex-col gap-1">Descrição<Input value={v.descricao} placeholder="Janela da varanda" onChange={(e) => mudarVao(i, { descricao: e.target.value })} /></label>
                      <label className="flex flex-col gap-1">Produto
                        <select className={classeSelect} value={v.tipo} onChange={(e) => mudarVao(i, { tipo: e.target.value as Vao['tipo'], modo: e.target.value === 'PERSIANA' ? (v.modo ?? 'DENTRO_VAO') : null })}>
                          <option value="CORTINA">Cortina</option><option value="PERSIANA">Persiana</option>
                        </select>
                      </label>
                    </div>
                    {v.tipo === 'PERSIANA' ? (
                      <>
                        <label className="flex flex-col gap-1">Instalação
                          <select className={classeSelect} value={v.modo ?? 'DENTRO_VAO'} onChange={(e) => mudarVao(i, { modo: e.target.value as Vao['modo'] })}>
                            {MODOS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                          </select>
                        </label>
                        <Medidas rotulo="Largura (cm)" nomes={['em cima', 'no meio', 'embaixo']} valores={v.larguras} onChange={(x) => mudarVao(i, { larguras: x })} />
                        <Medidas rotulo="Altura (cm)" nomes={['esquerda', 'no meio', 'direita']} valores={v.alturas} onChange={(x) => mudarVao(i, { alturas: x })} />
                        <label className="flex flex-col gap-1">Lado do comando
                          <select className={classeSelect} value={v.ladoComando ?? ''} onChange={(e) => mudarVao(i, { ladoComando: (e.target.value || null) as Vao['ladoComando'] })}>
                            <option value="">Não definido</option><option value="DIREITO">Direito</option><option value="ESQUERDO">Esquerdo</option>
                          </select>
                        </label>
                      </>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <CampoCm rotulo="Largura do trilho (cm)" valor={v.larguras[0] ?? ''} onChange={(x) => mudarVao(i, { larguras: [x, '', ''] })} />
                        <CampoCm rotulo="Altura pronta (cm)" valor={v.alturas[0] ?? ''} onChange={(x) => mudarVao(i, { alturas: [x, '', ''] })} />
                        <CampoCm rotulo="Cortineiro: profundidade (cm)" valor={v.profundidade} onChange={(x) => mudarVao(i, { profundidade: x })} />
                      </div>
                    )}
                    <label className="flex flex-col gap-1">Observações do vão
                      <Input value={v.observacoes ?? ''} placeholder="Ex.: tomada à direita, viga, ar-condicionado" onChange={(e) => mudarVao(i, { observacoes: e.target.value })} />
                    </label>
                    <Fotos lista={fotosDo(v.id)} podeTirar onAbrir={setFotoGrande} onTirar={tirarFoto} />
                    <FotoBotao rotulo="Foto deste vão" disabled={salvando} onFotos={(f) => fotos(f, v.id)} />
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => setVaos([...vaos, vaoNovo()])}>+ Adicionar vão</Button>
                <label className="flex flex-col gap-1">Anotações gerais da visita
                  <textarea className={classeTextarea} value={obsCampo} onChange={(e) => setObsCampo(e.target.value)} />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="lg" disabled={salvando} onClick={salvarVaos}>{salvando ? 'Salvando…' : 'Salvar medição'}</Button>
                  {m.vaos.length > 0 && <Button size="lg" variant="outline" onClick={() => { aplicar(m); setEditando(false); }}>Descartar mudanças</Button>}
                </div>
                <p className="text-xs text-muted-foreground">Funciona sem internet: fica no aparelho e é enviado quando a conexão voltar.</p>
              </>
            )}

            {(fotosDo(null).length > 0 || podeEditar) && (
              <div className="space-y-1 border-t pt-2">
                <p className="font-medium">Fotos gerais</p>
                <Fotos lista={fotosDo(null)} podeTirar={podeEditar} onAbrir={setFotoGrande} onTirar={tirarFoto} />
                {podeEditar && <FotoBotao rotulo="Foto geral" disabled={salvando} onFotos={(f) => fotos(f, null)} />}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------------- conferência */}
      {m.conferencia.pode && !m.pendente && !editando && (
        <Card>
          <CardHeader><CardTitle>Conferir as medidas</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{m.conferencia.explicacao}</p>
            <p className="text-muted-foreground">Compare as medidas da obra com as do {m.pedidoId ? 'pedido' : 'orçamento'} (aparecem embaixo de cada vão).</p>
            {offline ? <p className="text-amber-700 dark:text-amber-400">Conferir precisa de internet.</p> : (
              <div className="flex flex-wrap gap-2">
                <Button disabled={salvando} onClick={async () => {
                  const r = await acao<{ resultado: typeof resultado }>(`/api/medicoes/${m.id}/conferir`, { alterou: false }, 'Medição conferida.');
                  if (r?.resultado) { setResultado(r.resultado); setOk(r.resultado.mensagem); }
                }}>{m.conferencia.destino === 'PEDIDO' ? 'Medidas conferem: liberar o pedido' : 'Medidas conferem'}</Button>
                {m.conferencia.destino !== 'REGISTRO' && (
                  <Button variant="outline" disabled={salvando} onClick={async () => {
                    const r = await acao<{ resultado: typeof resultado }>(`/api/medicoes/${m.id}/conferir`, { alterou: true }, '');
                    if (r?.resultado) { setResultado(r.resultado); setOk(r.resultado.mensagem); }
                  }}>{m.conferencia.destino === 'PEDIDO' ? 'Medidas mudaram: abrir aditivo' : 'Medidas mudaram: nova versão'}</Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {resultado?.orcamentoId && (
        <Button asChild><a href={`/orcamentos?o=${resultado.orcamentoId}`}>Abrir o orçamento para ajustar</a></Button>
      )}
      {resultado?.pedidoId && !resultado.orcamentoId && (
        <Button asChild variant="outline"><a href={`/pedidos?p=${resultado.pedidoId}`}>Ver o pedido</a></Button>
      )}

      {fotoGrande && (
        <div role="dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setFotoGrande(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fotoSrc(fotoGrande)} alt={fotoGrande.legenda ?? 'Foto do vão'} className="max-h-full max-w-full rounded-md" />
        </div>
      )}
    </div>
  );
}

function CampoCm({ rotulo, valor, onChange }: { rotulo: string; valor: string; onChange: (v: string) => void }) {
  const m = cmParaMetros(valor);
  return (
    <label className="flex flex-col gap-1">{rotulo}
      <Input inputMode="decimal" value={valor} onChange={(e) => onChange(e.target.value)} />
      {m && <span className="text-xs text-muted-foreground">= {metrosTxt(m)}</span>}
    </label>
  );
}

function Medidas({ rotulo, nomes, valores, onChange }: { rotulo: string; nomes: string[]; valores: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="space-y-1">
      <span>{rotulo}</span>
      <div className="grid grid-cols-3 gap-2">
        {nomes.map((n, k) => (
          <CampoCm key={n} rotulo={n} valor={valores[k] ?? ''} onChange={(x) => onChange(valores.map((y, j) => (j === k ? x : y)))} />
        ))}
      </div>
    </div>
  );
}

function Fotos({ lista, podeTirar, onAbrir, onTirar }: { lista: FotoInfo[]; podeTirar: boolean; onAbrir: (f: FotoInfo) => void; onTirar: (f: FotoInfo) => void }) {
  if (!lista.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {lista.map((f) => (
        <div key={f.id} className="relative">
          <button type="button" onClick={() => onAbrir(f)} className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fotoSrc(f)} alt={f.legenda ?? 'Foto do vão'} className="h-20 w-20 rounded-md border object-cover" loading="lazy" />
          </button>
          {f.pendente && <span className="absolute bottom-1 left-1 rounded bg-amber-500 px-1 text-[10px] text-white">no aparelho</span>}
          {podeTirar && <button type="button" aria-label="Apagar foto" onClick={() => onTirar(f)} className="absolute -right-1 -top-1 h-6 w-6 rounded-full bg-destructive text-xs text-white">×</button>}
        </div>
      ))}
    </div>
  );
}

function FotoBotao({ rotulo, disabled, onFotos }: { rotulo: string; disabled: boolean; onFotos: (f: FileList | null) => void }) {
  return (
    <label className={`inline-flex h-8 cursor-pointer items-center rounded-md border bg-card px-3 text-sm font-medium hover:bg-muted ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
      📷 {rotulo}
      <input type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => { onFotos(e.target.files); e.target.value = ''; }} />
    </label>
  );
}
