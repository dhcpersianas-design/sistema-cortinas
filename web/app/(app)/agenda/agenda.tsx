'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect, classeTextarea, Mensagens } from '@/components/cadastro/campos';
import { buscar, type Cliente } from '@/lib/clientes-offline';
import { carregarPacote, chamar, contarPendentes, enviarPendentes, ErroApi, type Medicao } from '@/lib/medicoes-offline';
import { dataHoraBR, isoParaLocal, localParaIso, STATUS_PEDIDO } from '../pedidos/formato';
import { corMedicao, TelaMedicao } from './medicao';

type ResumoMedicao = {
  id: string; numero: string; status: string; statusNome: string; dataAgendada: string; duracaoHoras: string | null;
  clienteNome: string; clienteTelefone: string; endereco: string | null; responsavelNome: string | null;
  orcamentoCodigo: string | null; pedidoNumero: string | null; observacoes: string | null; qtdVaos: number;
};
type Instalacao = {
  id: string; numero: string; titulo: string | null; status: string; data: string; duracaoHoras: string | null;
  clienteNome: string; clienteTelefone: string; endereco: string | null; instaladorNome: string | null; vendedorNome: string;
};
type SemVisita = { tipo: 'ORCAMENTO' | 'PEDIDO'; id: string; orcamentoId: string; codigo: string; clienteId: string; clienteNome: string; vendedorNome: string; status: string };
type RespostaAgenda = {
  de: string; ate: string; medicoes: ResumoMedicao[]; instalacoes: Instalacao[];
  pendencias: { semVisita: SemVisita[]; aConferir: ResumoMedicao[]; atrasadas: ResumoMedicao[] };
};
type Evento = { tipo: 'MEDICAO' | 'INSTALACAO'; id: string; data: string; titulo: string; detalhe: string; status: string; statusNome: string; extra: string };
type Prefill = { clienteId: string; clienteNome: string; orcamentoId?: string | null } | null;

const p2 = (n: number) => String(n).padStart(2, '0');
const isoDia = (dt: Date) => `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
/** Segunda-feira da semana de `dt` + `semanas`. */
function semana(semanas: number) {
  const dt = new Date();
  dt.setHours(12, 0, 0, 0);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7) + semanas * 7);
  const fim = new Date(dt);
  fim.setDate(fim.getDate() + 6);
  return { de: isoDia(dt), ate: isoDia(fim) };
}
const hora = (v: string) => new Date(v).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const diaTitulo = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });

function irPara(q: string | null) {
  window.history.pushState(null, '', q ? `/agenda?${q}` : '/agenda');
}

export function Agenda({ admin }: { admin: boolean }) {
  const sp = useSearchParams();
  const aberta = sp.get('m');
  const novo = sp.get('novo');
  const [semanaN, setSemanaN] = useState(0);
  const [responsavel, setResponsavel] = useState('');
  const [vendedores, setVendedores] = useState<{ id: string; nome: string }[]>([]);
  const [dados, setDados] = useState<RespostaAgenda | null>(null);
  const [offline, setOffline] = useState<{ medicoes: Medicao[]; baixadoEm: string | null } | null>(null);
  const [pendentes, setPendentes] = useState(0);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Prefill>(null);
  const [recarregar, setRecarregar] = useState(0);

  const sincronizar = useCallback(async () => {
    const r = await enviarPendentes().catch(() => null);
    if (r?.recusados.length) setAvisos(r.recusados.map((x) => `Não enviado: ${x}`));
    if (r?.enviados) setAvisos((a) => [...a, `${r.enviados} registro(s) feito(s) sem internet foram enviados.`]);
    setPendentes(await contarPendentes());
  }, []);

  useEffect(() => {
    sincronizar();
    window.addEventListener('online', sincronizar);
    return () => window.removeEventListener('online', sincronizar);
  }, [sincronizar]);

  useEffect(() => {
    if (!admin) return;
    chamar<{ vendedores: { id: string; nome: string }[] }>('/api/clientes-vendedores').then((r) => setVendedores(r.vendedores)).catch(() => {});
  }, [admin]);

  useEffect(() => {
    if (aberta) return;
    (async () => {
      // Sempre atualiza o pacote da obra (fica no aparelho para medir sem internet).
      const pacote = await carregarPacote().catch(() => null);
      const { de, ate } = semana(semanaN);
      try {
        const r = await chamar<RespostaAgenda>(`/api/agenda?de=${de}&ate=${ate}${responsavel ? `&responsavel=${responsavel}` : ''}`);
        setDados(r); setOffline(null); setErro(null);
      } catch (e) {
        if (e instanceof ErroApi && e.status !== 503) { setErro(e.message); return; }
        setOffline({ medicoes: pacote?.medicoes ?? [], baixadoEm: pacote?.baixadoEm ?? null });
      }
    })();
  }, [aberta, semanaN, responsavel, pendentes, recarregar]);

  useEffect(() => {
    if (novo && sp.get('cliente')) setPrefill({ clienteId: sp.get('cliente')!, clienteNome: sp.get('nome') ?? '', orcamentoId: sp.get('orcamento') });
  }, [novo, sp]);

  if (aberta) return <TelaMedicao id={aberta} admin={admin} vendedores={vendedores} onVoltar={() => irPara(null)} onMudou={sincronizar} />;

  const eventos: Evento[] = offline
    ? offline.medicoes.map((m) => ({
      tipo: 'MEDICAO', id: m.id, data: m.dataAgendada, titulo: m.clienteNome, detalhe: m.endereco ?? 'Endereço não informado',
      status: m.status, statusNome: m.statusNome, extra: m.numero,
    }))
    : [
      ...(dados?.medicoes ?? []).map((m): Evento => ({
        tipo: 'MEDICAO', id: m.id, data: m.dataAgendada, titulo: m.clienteNome,
        detalhe: [m.endereco ?? 'Endereço não informado', admin ? m.responsavelNome : null, m.duracaoHoras ? `${m.duracaoHoras.replace('.', ',')} h` : null].filter(Boolean).join(' · '),
        status: m.status, statusNome: m.statusNome, extra: [m.numero, m.pedidoNumero ?? m.orcamentoCodigo].filter(Boolean).join(' · '),
      })),
      ...(dados?.instalacoes ?? []).map((i): Evento => ({
        tipo: 'INSTALACAO', id: i.id, data: i.data, titulo: i.clienteNome,
        detalhe: [i.endereco ?? 'Endereço não informado', i.instaladorNome, admin ? i.vendedorNome : null, i.duracaoHoras ? `${i.duracaoHoras.replace('.', ',')} h` : null].filter(Boolean).join(' · '),
        status: i.status, statusNome: STATUS_PEDIDO[i.status] ?? i.status, extra: i.numero,
      })),
    ].sort((a, b) => a.data.localeCompare(b.data));

  const porDia = new Map<string, Evento[]>();
  for (const e of eventos) {
    const k = isoDia(new Date(e.data));
    porDia.set(k, [...(porDia.get(k) ?? []), e]);
  }
  const hoje = isoDia(new Date());
  const pend = dados?.pendencias;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Agenda e medição</h1>
        {!offline && <Button onClick={() => setPrefill({ clienteId: '', clienteNome: '' })}>Marcar medição</Button>}
      </div>
      {offline && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          Sem internet: mostrando as suas visitas guardadas no aparelho{offline.baixadoEm ? ` (baixadas em ${dataHoraBR(offline.baixadoEm)})` : ''}.
          Dá para medir e tirar fotos normalmente; tudo é enviado quando a conexão voltar.
        </p>
      )}
      {pendentes > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{pendentes} registro(s) ou foto(s) aguardando internet para enviar.</p>}
      <Mensagens erro={erro} avisos={avisos} />

      {prefill && (
        <FormAgendar admin={admin} vendedores={vendedores} prefill={prefill}
          onFechar={() => { setPrefill(null); if (novo) irPara(null); }}
          onFeito={(id) => { setPrefill(null); irPara(`m=${id}`); }} />
      )}

      {!offline && pend && (pend.semVisita.length > 0 || pend.aConferir.length > 0 || pend.atrasadas.length > 0) && (
        <Card>
          <CardHeader><CardTitle>Precisa de atenção</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {pend.aConferir.length > 0 && (
              <div>
                <p className="font-medium">Medidas tiradas, falta conferir ({pend.aConferir.length})</p>
                {pend.aConferir.map((m) => (
                  <button key={m.id} type="button" onClick={() => irPara(`m=${m.id}`)} className="flex w-full flex-wrap gap-2 border-t py-1 text-left hover:underline">
                    <span className="font-medium">{m.clienteNome}</span><span className="text-muted-foreground">{m.numero} · {m.pedidoNumero ?? m.orcamentoCodigo ?? 'sem orçamento'}</span>
                  </button>
                ))}
              </div>
            )}
            {pend.atrasadas.length > 0 && (
              <div>
                <p className="font-medium">Visitas que passaram da data sem registro ({pend.atrasadas.length})</p>
                {pend.atrasadas.map((m) => (
                  <button key={m.id} type="button" onClick={() => irPara(`m=${m.id}`)} className="flex w-full flex-wrap gap-2 border-t py-1 text-left hover:underline">
                    <span className="font-medium">{m.clienteNome}</span><span className="text-muted-foreground">{dataHoraBR(m.dataAgendada)} · {m.numero}</span>
                  </button>
                ))}
              </div>
            )}
            {pend.semVisita.length > 0 && (
              <div>
                <p className="font-medium">Esperando medição, sem visita marcada ({pend.semVisita.length})</p>
                {pend.semVisita.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 border-t py-1">
                    <span className="font-medium">{s.clienteNome}</span>
                    <span className="text-muted-foreground">{s.tipo === 'PEDIDO' ? `Pedido ${s.codigo} (venda fechada)` : `Orçamento ${s.codigo}`}{admin ? ` · ${s.vendedorNome}` : ''}</span>
                    <Button size="sm" variant="outline" className="ml-auto" onClick={() => setPrefill({ clienteId: s.clienteId, clienteNome: s.clienteNome, orcamentoId: s.orcamentoId })}>Marcar</Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!offline && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setSemanaN(semanaN - 1)}>← Semana anterior</Button>
          <Button size="sm" variant={semanaN === 0 ? 'default' : 'outline'} onClick={() => setSemanaN(0)}>Esta semana</Button>
          <Button size="sm" variant="outline" onClick={() => setSemanaN(semanaN + 1)}>Próxima →</Button>
          {admin && (
            <select aria-label="Responsável" className={`${classeSelect} sm:ml-auto sm:w-56`} value={responsavel} onChange={(e) => setResponsavel(e.target.value)}>
              <option value="">Toda a equipe</option>
              {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
            </select>
          )}
          {dados && <span className="w-full text-xs text-muted-foreground">{diaTitulo(dados.de)} a {diaTitulo(dados.ate)}</span>}
        </div>
      )}

      {(dados || offline) && eventos.length === 0 && <p className="text-sm text-muted-foreground">Nada marcado neste período.</p>}
      {[...porDia.entries()].map(([dia, lista]) => (
        <section key={dia} className="space-y-2">
          <h2 className={`font-medium capitalize ${dia === hoje ? 'text-primary' : ''}`}>{dia === hoje ? 'Hoje, ' : ''}{diaTitulo(dia)}</h2>
          {lista.map((e) => (
            <button key={`${e.tipo}-${e.id}`} type="button"
              onClick={() => (e.tipo === 'MEDICAO' ? irPara(`m=${e.id}`) : window.location.assign(`/instalacoes?p=${e.id}`))}
              className="block w-full rounded-md border bg-card p-3 text-left text-sm hover:bg-muted">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{hora(e.data)}</span>
                <Badge className={e.tipo === 'MEDICAO' ? 'border-violet-500/50 text-violet-700 dark:text-violet-400' : 'border-sky-500/50 text-sky-700 dark:text-sky-400'}>
                  {e.tipo === 'MEDICAO' ? 'Medição' : 'Instalação'}
                </Badge>
                <span className="font-medium">{e.titulo}</span>
                {e.tipo === 'MEDICAO' && <Badge className={corMedicao(e.status)}>{e.statusNome}</Badge>}
                <span className="text-muted-foreground">{e.extra}</span>
              </div>
              <div className="mt-1 text-muted-foreground">{e.detalhe}</div>
            </button>
          ))}
        </section>
      ))}
      {!offline && <p className="text-xs text-muted-foreground">As instalações são marcadas no pedido (tela Pedidos) e aparecem aqui junto com as medições.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ marcar medição

type Projeto = { orcamentoId: string; codigo: string; versao: number; titulo: string | null; status: string; pedidoNumero: string | null; pedidoStatus: string | null };

function proximaHoraCheia() {
  const dt = new Date(Date.now() + 864e5);
  dt.setHours(9, 0, 0, 0);
  return isoParaLocal(dt.toISOString());
}

function FormAgendar({ admin, vendedores, prefill, onFechar, onFeito }: {
  admin: boolean; vendedores: { id: string; nome: string }[]; prefill: NonNullable<Prefill>; onFechar: () => void; onFeito: (id: string) => void;
}) {
  const [cliente, setCliente] = useState<{ id: string; nome: string } | null>(prefill.clienteId ? { id: prefill.clienteId, nome: prefill.clienteNome } : null);
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState<Cliente[]>([]);
  const [projetos, setProjetos] = useState<Projeto[]>([]);
  const [orcamentoId, setOrcamentoId] = useState(prefill.orcamentoId ?? '');
  const [quando, setQuando] = useState(proximaHoraCheia());
  const [duracao, setDuracao] = useState('1');
  const [responsavelId, setResponsavelId] = useState('');
  const [obs, setObs] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (cliente || busca.trim().length < 2) { setAchados([]); return; }
    const t = setTimeout(() => buscar(busca).then((r) => setAchados(r.clientes.filter((c) => !c.pendente).slice(0, 8))).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [busca, cliente]);

  useEffect(() => {
    if (!cliente) { setProjetos([]); return; }
    chamar<{ projetos: Projeto[] }>(`/api/clientes/${cliente.id}/projetos`).then((r) => {
      setProjetos(r.projetos);
      // Projeto já escolhido (veio da pendência) pode ser uma versão antiga: troca pela mais nova do mesmo projeto.
      if (prefill.orcamentoId && !r.projetos.some((p) => p.orcamentoId === prefill.orcamentoId) && r.projetos.length === 1) setOrcamentoId(r.projetos[0]!.orcamentoId);
    }).catch(() => setProjetos([]));
  }, [cliente, prefill.orcamentoId]);

  async function salvar() {
    if (!cliente) { setErro('Escolha o cliente.'); return; }
    if (!quando) { setErro('Informe o dia e a hora.'); return; }
    setErro(null); setSalvando(true);
    try {
      const r = await chamar<{ medicao: { id: string } }>('/api/medicoes', 'POST', {
        clienteId: cliente.id, orcamentoId: orcamentoId || null, dataAgendada: localParaIso(quando),
        duracaoHoras: duracao || null, responsavelId: responsavelId || null, observacoes: obs.trim() || null,
      });
      onFeito(r.medicao.id);
    } catch (e) { setErro(e instanceof ErroApi ? e.message : 'Sem internet: marcar a visita precisa de conexão.'); }
    setSalvando(false);
  }

  return (
    <Card>
      <CardHeader><CardTitle>Marcar medição</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="flex flex-col gap-1">Cliente
          {cliente ? (
            <span className="flex items-center gap-2"><strong>{cliente.nome || 'Cliente escolhido'}</strong>
              <Button size="sm" variant="ghost" onClick={() => { setCliente(null); setOrcamentoId(''); }}>trocar</Button></span>
          ) : (
            <Input placeholder="Nome, telefone ou CPF" value={busca} onChange={(e) => setBusca(e.target.value)} autoFocus />
          )}
        </label>
        {!cliente && achados.map((c) => (
          <button key={c.id} type="button" className="block w-full border-t py-1 text-left hover:underline" onClick={() => setCliente({ id: c.id, nome: c.nomeCompleto })}>
            {c.nomeCompleto} <span className="text-muted-foreground">{[c.bairro, c.cidade].filter(Boolean).join(', ')}</span>
          </button>
        ))}
        {cliente && (
          <label className="flex flex-col gap-1">Orçamento / pedido
            <select className={classeSelect} value={orcamentoId} onChange={(e) => setOrcamentoId(e.target.value)}>
              <option value="">Nenhum ainda (visita antes do orçamento)</option>
              {projetos.map((p) => (
                <option key={p.orcamentoId} value={p.orcamentoId}>
                  {p.codigo} v{p.versao}{p.titulo ? ` · ${p.titulo}` : ''}{p.pedidoNumero ? ` · pedido ${p.pedidoNumero} (${STATUS_PEDIDO[p.pedidoStatus ?? ''] ?? ''})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 sm:col-span-2">Dia e hora<Input type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} /></label>
          <label className="flex flex-col gap-1">Duração (horas)<Input inputMode="decimal" value={duracao} onChange={(e) => setDuracao(e.target.value)} /></label>
        </div>
        {admin && (
          <label className="flex flex-col gap-1">Quem vai medir
            <select className={classeSelect} value={responsavelId} onChange={(e) => setResponsavelId(e.target.value)}>
              <option value="">Eu mesmo</option>
              {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">Observações (portaria, o que levar, falar com quem)
          <textarea className={classeTextarea} value={obs} onChange={(e) => setObs(e.target.value)} />
        </label>
        <Mensagens erro={erro} />
        <div className="flex gap-2">
          <Button disabled={salvando} onClick={salvar}>{salvando ? 'Marcando…' : 'Marcar visita'}</Button>
          <Button variant="outline" onClick={onFechar}>Cancelar</Button>
        </div>
      </CardContent>
    </Card>
  );
}
