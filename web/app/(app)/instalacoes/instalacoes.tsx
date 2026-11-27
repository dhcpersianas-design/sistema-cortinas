'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeTextarea, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import {
  aceitePendente, carregarInstalacoes, contarAceitesPendentes, enviarAceitesPendentes, lerInstalacao, registrarAceite,
  type Instalacao,
} from '@/lib/instalacoes-offline';
import { moeda, qtd } from '../orcamentos/formato';
import { corStatus, dataHoraBR, diaSemana, STATUS_PEDIDO } from '../pedidos/formato';
import { QuadroAssinatura } from './assinatura';

type LinhaAgenda = {
  id: string; numero: string; titulo: string | null; status: string; clienteNome: string; clienteTelefone: string; endereco: string | null;
  instalacaoAgendada: string | null; duracaoHoras: string | null; instaladorNome: string | null; vendedorNome: string;
  previsaoEntrega: string | null; qtdItens: number;
};

/** +5511966662222 -> (11) 96666-2222 */
function telefone(t: string) {
  const n = t.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return t;
}

function irPara(id: string | null) {
  window.history.pushState(null, '', id ? `/instalacoes?p=${id}` : '/instalacoes');
}

export function Instalacoes({ admin }: { admin: boolean }) {
  const sp = useSearchParams();
  const aberto = sp.get('p');
  const [agenda, setAgenda] = useState<LinhaAgenda[] | null>(null);
  const [semData, setSemData] = useState<LinhaAgenda[]>([]);
  const [offline, setOffline] = useState(false);
  const [pendentes, setPendentes] = useState(0);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [baixadoEm, setBaixadoEm] = useState<string | null>(null);

  const sincronizar = useCallback(async () => {
    const r = await enviarAceitesPendentes().catch(() => null);
    if (r?.recusados.length) setAvisos(r.recusados.map((x) => `Aceite recusado: ${x}`));
    if (r?.enviados) setAvisos((a) => [...a, `${r.enviados} aceite(s) feito(s) sem internet foram enviados.`]);
    setPendentes(await contarAceitesPendentes());
  }, []);

  useEffect(() => {
    sincronizar();
    window.addEventListener('online', sincronizar);
    return () => window.removeEventListener('online', sincronizar);
  }, [sincronizar]);

  useEffect(() => {
    if (aberto) return;
    (async () => {
      // Sempre atualiza o pacote da obra (fica no aparelho para usar sem internet).
      const pacote = await carregarInstalacoes().catch(() => null);
      if (pacote) setBaixadoEm(pacote.baixadoEm);
      try {
        const r = await api<{ agenda: LinhaAgenda[]; semData: LinhaAgenda[] }>('/api/instalacoes');
        setAgenda(r.agenda); setSemData(r.semData); setOffline(false);
      } catch {
        setOffline(true);
        setAgenda((pacote?.instalacoes ?? []).map((i) => ({
          id: i.id, numero: i.numero, titulo: i.titulo, status: i.status, clienteNome: i.clienteNome, clienteTelefone: i.clienteTelefone,
          endereco: i.endereco, instalacaoAgendada: i.instalacaoAgendada, duracaoHoras: null, instaladorNome: i.instaladorNome,
          vendedorNome: '', previsaoEntrega: null, qtdItens: i.itens.length,
        })));
      }
    })();
  }, [aberto, pendentes]);

  if (aberto) return <Aceite id={aberto} onVoltar={() => irPara(null)} onFeito={sincronizar} />;

  const porDia = new Map<string, LinhaAgenda[]>();
  for (const a of agenda ?? []) {
    const k = a.instalacaoAgendada ? new Date(a.instalacaoAgendada).toDateString() : '';
    porDia.set(k, [...(porDia.get(k) ?? []), a]);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Instalações</h1>
      {offline && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          Sem internet: mostrando as instalações guardadas no aparelho{baixadoEm ? ` (baixadas em ${dataHoraBR(baixadoEm)})` : ''}. O aceite funciona normalmente.
        </p>
      )}
      {pendentes > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{pendentes} aceite(s) aguardando internet para enviar.</p>}
      <Mensagens avisos={avisos} />
      {!admin && <p className="text-sm text-muted-foreground">Quem agenda é o administrador. Abra a instalação na obra para colher o aceite do cliente.</p>}

      {agenda && agenda.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma instalação agendada.</p>}
      {[...porDia.entries()].map(([dia, lista]) => (
        <section key={dia} className="space-y-2">
          <h2 className="font-medium capitalize">{lista[0]?.instalacaoAgendada ? diaSemana(lista[0].instalacaoAgendada) : 'Sem data'}</h2>
          {lista.map((a) => (
            <div key={a.id} className="rounded-md border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.instalacaoAgendada ? new Date(a.instalacaoAgendada).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                <span className="font-medium">{a.clienteNome}</span>
                <Badge className={corStatus(a.status)}>{a.status === 'INSTALACAO_AGENDADA' ? 'Pronto' : STATUS_PEDIDO[a.status] ?? a.status}</Badge>
                <span className="text-muted-foreground">{a.numero}</span>
              </div>
              <div className="mt-1 text-muted-foreground">
                {a.endereco ?? 'Endereço não informado'}{a.instaladorNome ? ` · ${a.instaladorNome}` : ''}{a.duracaoHoras ? ` · ${a.duracaoHoras} h` : ''} · {a.qtdItens} item(ns)
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {a.status !== 'INSTALADO_CONCLUIDO' && <Button size="sm" onClick={() => irPara(a.id)}>Abrir na obra / aceite</Button>}
                {!offline && <Button asChild size="sm" variant="outline"><a href={`/pedidos?p=${a.id}`}>Pedido</a></Button>}
                {!offline && <Button asChild size="sm" variant="outline"><a href={`/api/pedidos/${a.id}/os.pdf`} target="_blank" rel="noopener">OS (PDF)</a></Button>}
              </div>
            </div>
          ))}
        </section>
      ))}

      {semData.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Sem data marcada</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {semData.map((a) => (
              <a key={a.id} href={`/pedidos?p=${a.id}`} className="flex flex-wrap gap-2 border-t py-1 hover:underline">
                <span className="font-medium">{a.numero}</span><span>{a.clienteNome}</span>
                <Badge className={corStatus(a.status)}>{STATUS_PEDIDO[a.status]}</Badge>
              </a>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ aceite na obra

function Aceite({ id, onVoltar, onFeito }: { id: string; onVoltar: () => void; onFeito: () => void }) {
  const [inst, setInst] = useState<Instalacao | null | undefined>(undefined);
  const [conferido, setConferido] = useState<Record<string, boolean>>({});
  const [nome, setNome] = useState('');
  const [documento, setDocumento] = useState('');
  const [obs, setObs] = useState('');
  const [assinatura, setAssinatura] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [feito, setFeito] = useState<{ offline: boolean; avisos: string[] } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [jaPendente, setJaPendente] = useState(false);

  useEffect(() => {
    (async () => {
      const i = await lerInstalacao(id);
      setInst(i);
      if (i) { setNome(i.clienteNome); setConferido(Object.fromEntries(i.itens.map((x) => [x.id, false]))); }
      setJaPendente(Boolean(await aceitePendente(id)));
    })();
  }, [id]);

  if (inst === undefined) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (!inst) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onVoltar}>← Instalações</Button>
        <Mensagens erro="Instalação não encontrada no aparelho. Com internet, abra Instalações para baixar a agenda." />
      </div>
    );
  }
  if (feito || jaPendente) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onVoltar}>← Instalações</Button>
        <Mensagens ok={feito?.offline || jaPendente ? 'Aceite guardado no aparelho.' : 'Aceite registrado. Pedido concluído.'} avisos={feito?.avisos ?? ['Será enviado quando a internet voltar.']} />
        {!feito?.offline && !jaPendente && <Button asChild variant="outline"><a href={`/api/pedidos/${id}/termo-aceite.pdf`} target="_blank" rel="noopener">Ver termo assinado (PDF)</a></Button>}
      </div>
    );
  }

  const todos = inst.itens.every((x) => conferido[x.id]);
  async function enviar() {
    if (!assinatura) { setErro('Falta a assinatura do cliente.'); return; }
    if (nome.trim().length < 2) { setErro('Informe o nome de quem recebeu.'); return; }
    if (!todos && !obs.trim()) { setErro('Há item não conferido: explique nas observações (vai como ressalva).'); return; }
    setErro(null); setEnviando(true);
    try {
      const r = await registrarAceite(inst!, {
        id: crypto.randomUUID(), nomeRecebedor: nome.trim(), documentoRecebedor: documento.trim() || null, assinaturaPng: assinatura,
        checklist: inst!.itens.map((x) => ({ itemId: x.id, descricao: `${x.ambiente}: ${x.descricao}`, ok: Boolean(conferido[x.id]) })),
        observacoes: obs.trim() || null, assinadoEm: new Date().toISOString(),
      });
      setFeito(r);
      onFeito();
    } catch (e) { setErro((e as Error).message); }
    setEnviando(false);
  }

  const mapa = inst.endereco ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(inst.endereco)}` : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onVoltar}>← Instalações</Button>
        <h1 className="text-xl font-semibold">{inst.clienteNome}</h1>
        <Badge>{inst.numero}</Badge>
      </div>

      <Card>
        <CardContent className="space-y-1 pt-4 text-sm">
          {inst.instalacaoAgendada && <p><strong>{dataHoraBR(inst.instalacaoAgendada)}</strong>{inst.instaladorNome ? ` · ${inst.instaladorNome}` : ''}</p>}
          <p>{inst.endereco ?? 'Endereço não informado'} {mapa && <a className="underline" href={mapa} target="_blank" rel="noopener">mapa</a>}</p>
          <p><a className="underline" href={`tel:${inst.clienteTelefone}`}>{telefone(inst.clienteTelefone)}</a></p>
          {inst.obsAcesso && <p className="text-amber-700 dark:text-amber-400">Acesso/condomínio: {inst.obsAcesso}</p>}
          {inst.obsInstalacao && <p>Observações: {inst.obsInstalacao}</p>}
          {Number(inst.saldo) > 0 && <p className="font-medium">Saldo a receber do cliente: {moeda(inst.saldo)}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Conferir com o cliente</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {inst.itens.map((x) => (
            <label key={x.id} className="flex items-start gap-3 border-t pt-2">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={Boolean(conferido[x.id])} onChange={(e) => setConferido({ ...conferido, [x.id]: e.target.checked })} />
              <span className="flex-1">
                <span className="font-medium">{x.ambiente}</span>: {x.descricao}
                <span className="block text-xs text-muted-foreground">{x.medidas}</span>
                {x.pecas.length > 0 && (
                  <span className="block text-xs text-muted-foreground">Peças: {x.pecas.map((pc) => `${qtd(pc.quantidade, pc.unidade)} ${pc.unidade} ${pc.descricao}`).join(' · ')}</span>
                )}
              </span>
            </label>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => setConferido(Object.fromEntries(inst.itens.map((x) => [x.id, true])))}>Marcar todos</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Aceite do cliente</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">Nome de quem recebeu<Input value={nome} onChange={(e) => setNome(e.target.value)} /></label>
            <label className="flex flex-col gap-1">Documento (opcional)<Input value={documento} inputMode="numeric" onChange={(e) => setDocumento(e.target.value)} /></label>
          </div>
          <label className="flex flex-col gap-1">Observações {!todos && <span className="text-xs text-amber-700 dark:text-amber-400">(obrigatório: há item não conferido)</span>}
            <textarea className={classeTextarea} value={obs} onChange={(e) => setObs(e.target.value)} />
          </label>
          <p className="text-muted-foreground">Declaro que os itens acima foram instalados e conferidos, e que recebi as orientações de uso.</p>
          <QuadroAssinatura onChange={setAssinatura} />
          <Mensagens erro={erro} />
          <Button size="lg" className="w-full sm:w-auto" disabled={enviando || !assinatura} onClick={enviar}>
            {enviando ? 'Registrando…' : 'Registrar aceite'}
          </Button>
          <p className="text-xs text-muted-foreground">Funciona sem internet: o aceite fica no aparelho e é enviado quando a conexão voltar.</p>
        </CardContent>
      </Card>
    </div>
  );
}
