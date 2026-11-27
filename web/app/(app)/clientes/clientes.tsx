'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Mensagens } from '@/components/cadastro/campos';
import {
  baixarPacote, buscar, contarPendentes, enviarFila, lerRecusados, limparRecusados, type Cliente,
} from '@/lib/clientes-offline';
import { FichaCliente } from './ficha-cliente';
import { FormCliente } from './form-cliente';

/** Troca a tela sem ir ao servidor (funciona offline): ?c=<id>, ?c=novo, ?c=<id>&editar=1. */
function irPara(params: Record<string, string> | null) {
  const url = params ? `/clientes?${new URLSearchParams(params)}` : '/clientes';
  window.history.pushState(null, '', url);
}

export function Clientes({ admin }: { admin: boolean }) {
  const sp = useSearchParams();
  const aberto = sp.get('c');
  const editando = sp.get('editar') === '1';

  const [q, setQ] = useState('');
  const [lista, setLista] = useState<Cliente[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [pendentes, setPendentes] = useState(0);
  const [recusados, setRecusados] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [versao, setVersao] = useState(0); // força nova busca após gravar/sincronizar

  const sincronizar = useCallback(async () => {
    try {
      const r = await enviarFila();
      if (r.enviados || r.recusados.length) setVersao((v) => v + 1);
      await baixarPacote();
    } catch { /* sem internet: fica com o que está no aparelho */ }
    setPendentes(await contarPendentes());
    setRecusados(await lerRecusados());
  }, []);

  useEffect(() => {
    sincronizar();
    window.addEventListener('online', sincronizar);
    return () => window.removeEventListener('online', sincronizar);
  }, [sincronizar]);

  useEffect(() => {
    let vivo = true;
    const t = setTimeout(async () => {
      try {
        const r = await buscar(q);
        if (!vivo) return;
        setLista(r.clientes); setOffline(r.offline); setErro(null);
      } catch (e) { if (vivo) setErro((e as Error).message); }
    }, q ? 250 : 0);
    return () => { vivo = false; clearTimeout(t); };
  }, [q, versao]);

  async function aposGravar(c: Cliente) {
    setPendentes(await contarPendentes());
    setVersao((v) => v + 1);
    irPara({ c: c.id });
  }

  const barraStatus = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {offline && <Badge className="border-amber-500/50 text-amber-700 dark:text-amber-400">Sem internet: dados do aparelho</Badge>}
      {pendentes > 0 && <Badge className="border-amber-500/50">{pendentes} alteração(ões) aguardando envio</Badge>}
      {!offline && pendentes === 0 && lista && <span className="text-muted-foreground">Sincronizado</span>}
    </div>
  );

  if (aberto === 'novo' || (aberto && editando)) {
    return (
      <div className="flex flex-col gap-4">
        {barraStatus}
        <FormCliente clienteId={aberto === 'novo' ? null : aberto} admin={admin}
          onSalvo={aposGravar} onCancelar={() => irPara(aberto === 'novo' ? null : { c: aberto })} />
      </div>
    );
  }
  if (aberto) {
    return (
      <div className="flex flex-col gap-4">
        {barraStatus}
        <FichaCliente id={aberto} admin={admin} onVoltar={() => irPara(null)} onEditar={() => irPara({ c: aberto, editar: '1' })}
          onAlterado={() => setVersao((v) => v + 1)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Clientes</h1>
        <Button onClick={() => irPara({ c: 'novo' })}>Novo cliente</Button>
      </div>
      {barraStatus}
      {recusados.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3 text-sm">
          <strong>Alterações feitas sem internet que o sistema recusou:</strong>
          <ul className="list-disc pl-5">{recusados.map((r) => <li key={r}>{r}</li>)}</ul>
          <Button variant="outline" size="sm" className="self-start" onClick={async () => { await limparRecusados(); setRecusados([]); }}>Entendi</Button>
        </div>
      )}
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
        placeholder="Buscar por nome, telefone, CPF, cidade ou produto (ex.: linho, wave)" aria-label="Buscar clientes" />
      <Mensagens erro={erro} />
      {lista === null ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : lista.length === 0 ? (
        <p className="text-sm text-muted-foreground">{q ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.'}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {lista.map((c) => (
            <Card key={c.id} className="cursor-pointer transition-colors hover:bg-muted" onClick={() => irPara({ c: c.id })}>
              <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 pt-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {c.nomeCompleto} {c.pendente && <Badge className="ml-1 border-amber-500/50">não enviado</Badge>}
                    {c.ativo === false && <Badge className="ml-1 text-muted-foreground">inativo</Badge>}
                  </div>
                  <div className="truncate text-sm text-muted-foreground">
                    {[c.telefoneFormatado, [c.bairro, c.cidade].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {admin && c.vendedorResponsavelNome && <span className="text-xs text-muted-foreground">{c.vendedorResponsavelNome}</span>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
