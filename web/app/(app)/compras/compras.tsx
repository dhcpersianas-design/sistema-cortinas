'use client';
import { useCallback, useEffect, useState } from 'react';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { CartaoOrdem, STATUS_ORDEM, type Ordem } from '../pedidos/ordens';

/** Todas as ordens de compra (por fornecedor), da mais urgente para a mais antiga. */
export function Compras() {
  const [status, setStatus] = useState('ABERTA');
  const [ordens, setOrdens] = useState<Ordem[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await api<{ ordens: Ordem[] }>(`/api/compras${status ? `?status=${status}` : ''}`);
      setOrdens(r.ordens);
    } catch (e) { setErro(e instanceof TypeError ? 'Sem internet.' : (e as Error).message); }
  }, [status]);
  useEffect(() => { carregar(); }, [carregar]);

  const porFornecedor = new Map<string, Ordem[]>();
  for (const o of ordens ?? []) {
    const k = o.fornecedorNome ?? 'Fornecedor a definir';
    porFornecedor.set(k, [...(porFornecedor.get(k) ?? []), o]);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Compras e produção</h1>
      <p className="text-sm text-muted-foreground">
        As ordens nascem sozinhas quando o sinal do pedido é confirmado, uma por fornecedor (tecidos, costureira, fábrica de persianas...).
        Marque &quot;enviada&quot; quando mandar ao fornecedor e &quot;chegou&quot; quando receber: o pedido anda sozinho.
      </p>
      <select className={`${classeSelect} w-56`} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Todas</option>
        {Object.entries(STATUS_ORDEM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <Mensagens erro={erro} ok={ok} />
      {ordens && ordens.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma ordem nesta situação.</p>}
      {[...porFornecedor.entries()].map(([forn, lista]) => (
        <section key={forn} className="space-y-2">
          <h2 className="font-medium">{forn} <span className="text-sm text-muted-foreground">({lista.length})</span></h2>
          {lista.map((o) => (
            <CartaoOrdem key={o.id} ordem={o} mostrarPedido onMudou={carregar} onErro={(m, okMsg) => { setErro(m); setOk(okMsg ?? null); }} />
          ))}
        </section>
      ))}
    </div>
  );
}
