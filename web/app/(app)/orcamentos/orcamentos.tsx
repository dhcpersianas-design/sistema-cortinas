'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { buscar as buscarClientes, enviarFila as enviarClientes, type Cliente } from '@/lib/clientes-offline';
import {
  baixarPacote, contarPendentes, CONDICOES_PADRAO, enviarPendentes, gravarOrcamento, listar, type ResumoLista,
} from '@/lib/orcamentos-offline';
import { EditorOrcamento } from './editor';
import { corSemaforo, moeda, STATUS } from './formato';

/** Troca a tela sem ir ao servidor (funciona offline): ?o=<id> abre o configurador. */
function irPara(id: string | null, substituir = false) {
  const url = id ? `/orcamentos?o=${id}` : '/orcamentos';
  if (substituir) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
}

export function Orcamentos({ admin, verCusto }: { admin: boolean; verCusto: boolean }) {
  const sp = useSearchParams();
  const aberto = sp.get('o');
  const clienteInicial = sp.get('cliente');

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [lista, setLista] = useState<ResumoLista[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [pendentes, setPendentes] = useState(0);
  const [erro, setErro] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [versao, setVersao] = useState(0);
  const [novo, setNovo] = useState(Boolean(clienteInicial));
  // Mensagem que sobrevive à troca de versão (o configurador reabre com o novo id).
  const [recado, setRecado] = useState<string | null>(null);

  const sincronizar = useCallback(async () => {
    try {
      // Clientes cadastrados na obra vão antes: o orçamento depende deles.
      await enviarClientes().catch(() => null);
      const r = await enviarPendentes();
      if (r.avisos.length || r.recusados.length) setAvisos([...r.avisos, ...r.recusados.map((x) => `Recusado: ${x}`)]);
      if (r.enviados) setVersao((v) => v + 1);
      await baixarPacote();
    } catch { /* sem internet */ }
    setPendentes(await contarPendentes());
  }, []);

  useEffect(() => {
    sincronizar();
    window.addEventListener('online', sincronizar);
    return () => window.removeEventListener('online', sincronizar);
  }, [sincronizar]);

  useEffect(() => {
    if (aberto) return;
    let vivo = true;
    const t = setTimeout(async () => {
      try {
        const r = await listar(q, status);
        if (vivo) { setLista(r.orcamentos); setOffline(r.offline); setErro(null); }
      } catch (e) { if (vivo) setErro((e as Error).message); }
    }, q ? 250 : 0);
    return () => { vivo = false; clearTimeout(t); };
  }, [q, status, versao, aberto]);

  async function criar(c: Cliente) {
    setErro(null);
    try {
      const r = await gravarOrcamento({
        id: crypto.randomUUID(), status: 'RASCUNHO', titulo: null, clienteId: c.id, clienteNome: c.nomeCompleto,
        atualizadoEm: null, editavel: true, condicoes: CONDICOES_PADRAO, itens: [],
      });
      setNovo(false);
      setPendentes(await contarPendentes());
      irPara(r.orcamento.id);
    } catch (e) { setErro((e as Error).message); }
  }

  if (aberto) {
    return (
      <EditorOrcamento key={aberto} id={aberto} admin={admin} verCusto={verCusto} recado={recado}
        onVoltar={() => { irPara(null); setRecado(null); setVersao((v) => v + 1); }}
        onTrocarId={(id, msg) => { setRecado(msg ?? null); irPara(id, true); }} />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Orçamentos</h1>
        <Button onClick={() => setNovo((v) => !v)}>Novo orçamento</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {offline && <Badge className="border-amber-500/50 text-amber-700 dark:text-amber-400">Sem internet: dados do aparelho</Badge>}
        {pendentes > 0 && <Badge className="border-amber-500/50 text-amber-700 dark:text-amber-400">{pendentes} orçamento(s) aguardando envio</Badge>}
        {pendentes > 0 && !offline && <button type="button" className="underline" onClick={sincronizar}>Enviar agora</button>}
      </div>
      <Mensagens erro={erro} avisos={avisos} />

      {novo && <EscolherCliente inicial={clienteInicial} onEscolher={criar} onCancelar={() => setNovo(false)} />}

      <div className="flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Buscar por cliente, código ou obra" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${classeSelect} max-w-52`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          {Object.entries(STATUS).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
        </select>
      </div>

      {lista === null ? <p className="text-sm text-muted-foreground">Carregando…</p> : lista.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum orçamento encontrado.</p>
      ) : (
        <div className="grid gap-2">
          {lista.map((o) => (
            <button key={o.id} type="button" className="text-left" onClick={() => irPara(o.id)}>
              <Card className="transition-colors hover:bg-muted">
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
                  <div>
                    <p className="font-medium">{o.clienteNome}{o.titulo ? ` · ${o.titulo}` : ''}</p>
                    <p className="text-xs text-muted-foreground">
                      {o.codigo ?? 'Ainda sem código'}{o.versao ? ` · v${o.versao}` : ''} · {o.qtdItens} item(ns){admin && o.vendedorNome ? ` · ${o.vendedorNome}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {o.pendente && <Badge className="border-amber-500/50 text-amber-700 dark:text-amber-400">No aparelho</Badge>}
                    {o.semaforo && o.semaforo !== 'PENDENTE' && <Badge className={corSemaforo(o.semaforo)}>{o.semaforo.toLowerCase()}</Badge>}
                    <Badge>{STATUS[o.status] ?? o.status}</Badge>
                    <span className="font-semibold">{moeda(o.total)}</span>
                  </div>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EscolherCliente({ inicial, onEscolher, onCancelar }: { inicial: string | null; onEscolher: (c: Cliente) => void; onCancelar: () => void }) {
  const [q, setQ] = useState('');
  const [lista, setLista] = useState<Cliente[]>([]);
  useEffect(() => {
    let vivo = true;
    const t = setTimeout(async () => {
      try {
        const r = await buscarClientes(q);
        if (!vivo) return;
        setLista(r.clientes.slice(0, 8));
        const c = inicial ? r.clientes.find((x) => x.id === inicial) : undefined;
        if (c && !q) setLista([c]);
      } catch { /* */ }
    }, q ? 250 : 0);
    return () => { vivo = false; clearTimeout(t); };
  }, [q, inicial]);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-medium">Para qual cliente?</p>
        <Input autoFocus placeholder="Nome, telefone ou CPF" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="grid gap-1">
          {lista.map((c) => (
            <button key={c.id} type="button" className="rounded-md border px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => onEscolher(c)}>
              {c.nomeCompleto} <span className="text-xs text-muted-foreground">{c.telefoneFormatado}{c.pendente ? ' · ainda no aparelho' : ''}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Cliente novo? Cadastre em <a className="underline" href="/clientes?c=novo">Clientes</a> (funciona sem internet).</p>
        <Button variant="ghost" size="sm" onClick={onCancelar}>Cancelar</Button>
      </CardContent>
    </Card>
  );
}
