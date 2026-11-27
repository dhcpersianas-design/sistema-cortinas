'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { dataBR } from '../pedidos/formato';

type Item = {
  id: string; pedidoId: string; numero: string; cliente: string; telefone: string; vendedor: string;
  dataPrevista: string; status: 'PENDENTE' | 'FEITO' | 'CANCELADO'; nota: number | null; comentario: string | null; paraHoje: boolean;
};

/** Pós-venda: ligar para o cliente alguns dias depois da instalação (spec: +7 dias) e anotar a avaliação. */
export function PosVenda() {
  const [status, setStatus] = useState('PENDENTE');
  const [lista, setLista] = useState<Item[] | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const carregar = useCallback(() => api<{ posVenda: Item[] }>(`/api/pos-venda?status=${status}`).then((r) => setLista(r.posVenda))
    .catch((e) => setErro(e instanceof TypeError ? 'Sem internet.' : (e as Error).message)), [status]);
  useEffect(() => { carregar(); }, [carregar]);

  const zap = (tel: string, nome: string) => `https://wa.me/${tel.replace(/\D/g, '')}?text=${encodeURIComponent(`Olá, ${nome.split(' ')[0]}! Tudo bem? Passando para saber se ficou tudo certo com as cortinas e persianas. Ficou alguma dúvida?`)}`;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Pós-venda</h1>
      <p className="text-sm text-muted-foreground">Depois da instalação, o sistema lembra de falar com o cliente. Anote como foi e a nota que ele deu.</p>
      <select className={`${classeSelect} w-48`} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="PENDENTE">A fazer</option><option value="FEITO">Feitos</option><option value="TODOS">Todos</option>
      </select>
      <Mensagens erro={erro} ok={ok} />
      {lista && lista.length === 0 && <p className="text-sm text-muted-foreground">Nada por aqui.</p>}
      {lista?.map((i) => (
        <div key={i.id} className="rounded-md border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 font-medium">{i.cliente}</span>
            {i.status === 'PENDENTE'
              ? <Badge className={i.paraHoje ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300' : ''}>{i.paraHoje ? 'Fazer agora' : `A partir de ${dataBR(i.dataPrevista)}`}</Badge>
              : <Badge>{i.status === 'FEITO' ? `Feito${i.nota ? ` · nota ${i.nota}/5` : ''}` : 'Cancelado'}</Badge>}
          </div>
          <div className="text-xs text-muted-foreground">
            <Link className="underline" href={`/pedidos?p=${i.pedidoId}`}>{i.numero}</Link> · vendedor {i.vendedor}
          </div>
          {i.comentario && <p className="mt-1">{i.comentario}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline"><a href={zap(i.telefone, i.cliente)} target="_blank" rel="noopener">WhatsApp</a></Button>
            {i.status === 'PENDENTE' && <Button size="sm" onClick={() => setAberto(aberto === i.id ? null : i.id)}>Registrar contato</Button>}
          </div>
          {aberto === i.id && (
            <form className="mt-2 grid gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-4" onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                await api(`/api/pos-venda/${i.id}`, { method: 'POST', corpo: { status: 'FEITO', nota: f.get('nota') ? Number(f.get('nota')) : null, comentario: f.get('comentario') || null } });
                setOk('Pós-venda registrado.'); setAberto(null); carregar();
              } catch (x) { setErro((x as Error).message); }
            }}>
              <label className="flex flex-col gap-1">Nota do cliente
                <select name="nota" className={classeSelect} defaultValue="">
                  <option value="">Sem nota</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">Como foi<Input name="comentario" placeholder="Ex.: adorou, pediu orçamento do quarto" /></label>
              <div className="flex items-end"><Button>Salvar</Button></div>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}
