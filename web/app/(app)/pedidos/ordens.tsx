'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { classeSelect } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { moeda, qtd } from '../orcamentos/formato';
import { dataBR } from './formato';

export type Ordem = {
  id: string; numero: string; pedidoId: string; pedidoNumero: string; clienteNome: string;
  fornecedorId: string | null; fornecedorNome: string | null; fornecedorCategoria: string | null; fornecedorWhatsapp: string | null;
  tipo: 'COMPRA' | 'COSTURA' | 'FABRICA'; status: 'ABERTA' | 'ENVIADA' | 'RECEBIDA' | 'CANCELADA';
  custoPrevisto: string; custoReal: string | null; previsaoEntrega: string | null; observacoes: string | null;
  criadoEm: string; enviadaEm: string | null; recebidaEm: string | null; aditivoNumero: number | null; atrasada: boolean;
  itens: { sku: string; descricao: string; unidade: string; quantidade: string; ambiente: string | null }[];
};

export const STATUS_ORDEM: Record<string, string> = { ABERTA: 'A enviar', ENVIADA: 'Enviada (aguardando)', RECEBIDA: 'Recebida', CANCELADA: 'Cancelada' };
const TIPO: Record<string, string> = { COMPRA: 'Compra', COSTURA: 'Costura', FABRICA: 'Fábrica' };
const COR: Record<string, string> = {
  ABERTA: 'border-amber-500/50 text-amber-700 dark:text-amber-400',
  ENVIADA: 'border-sky-500/50 text-sky-700 dark:text-sky-400',
  RECEBIDA: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400',
  CANCELADA: 'text-muted-foreground line-through',
};

type Fornecedor = { id: string; nomeFantasia: string; categoria: string };
let fornecedoresCache: Promise<Fornecedor[]> | null = null;
function fornecedores() {
  fornecedoresCache ??= api<{ fornecedores: Fornecedor[] }>('/api/fornecedores').then((r) => r.fornecedores).catch(() => { fornecedoresCache = null; return []; });
  return fornecedoresCache;
}

/** Uma ordem de compra com as ações do dia a dia (enviar, receber, cancelar, mandar pelo WhatsApp). */
export function CartaoOrdem({ ordem, mostrarPedido, onMudou, onErro }: {
  ordem: Ordem; mostrarPedido?: boolean; onMudou: () => void; onErro: (m: string | null, ok?: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [lista, setLista] = useState<Fornecedor[]>([]);
  const [custo, setCusto] = useState('');
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { if (aberto && ordem.status === 'ABERTA') fornecedores().then(setLista); }, [aberto, ordem.status]);

  async function agir(corpo: Record<string, unknown>, ok: string) {
    setOcupado(true);
    try { await api(`/api/compras/${ordem.id}`, { method: 'POST', corpo }); onErro(null, ok); onMudou(); }
    catch (e) { onErro((e as Error).message); }
    setOcupado(false);
  }

  async function whatsapp(tipo: 'ORDEM_COMPRA' | 'FICHA_CORTE' | 'PEDIDO_FABRICA') {
    try {
      const r = await api<{ whatsapp: string }>(`/api/pedidos/${ordem.pedidoId}/link-documento`, {
        method: 'POST', corpo: { tipo, ordemCompraId: ordem.id, origem: window.location.origin },
      });
      window.open(r.whatsapp, '_blank', 'noopener');
    } catch (e) { onErro((e as Error).message); }
  }

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => setAberto(!aberto)}>
          {aberto ? '▾' : '▸'} {ordem.numero}
        </button>
        <Badge className={COR[ordem.status]}>{STATUS_ORDEM[ordem.status]}</Badge>
        <Badge className="text-muted-foreground">{TIPO[ordem.tipo]}</Badge>
        {ordem.aditivoNumero && <Badge className="text-muted-foreground">Aditivo {ordem.aditivoNumero}</Badge>}
        {ordem.atrasada && <Badge className="border-red-500/50 text-red-700 dark:text-red-400">Atrasada</Badge>}
        <span className="flex-1">{ordem.fornecedorNome ?? <em className="text-amber-700 dark:text-amber-400">Fornecedor a definir</em>}</span>
        <span className="text-muted-foreground">{moeda(ordem.custoReal ?? ordem.custoPrevisto)}</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {mostrarPedido && <>Pedido <a className="underline" href={`/pedidos?p=${ordem.pedidoId}`}>{ordem.pedidoNumero}</a> · {ordem.clienteNome} · </>}
        {ordem.itens.length} item(ns){ordem.previsaoEntrega ? ` · entrega ${dataBR(ordem.previsaoEntrega)}` : ''}
      </div>

      {aberto && (
        <div className="mt-3 space-y-3">
          <ul className="space-y-0.5 text-xs">
            {ordem.itens.map((i, k) => (
              <li key={k} className="flex gap-2 border-t pt-0.5">
                <span className="w-20 shrink-0 text-muted-foreground">{i.sku}</span>
                <span className="flex-1">{i.descricao}{i.ambiente ? <span className="text-muted-foreground"> · {i.ambiente}</span> : null}</span>
                <span>{qtd(i.quantidade, i.unidade)} {i.unidade}</span>
              </li>
            ))}
          </ul>
          {ordem.status === 'ABERTA' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs">Fornecedor</span>
              <select className={classeSelect} value={ordem.fornecedorId ?? ''} disabled={ocupado}
                onChange={(e) => agir({ acao: 'EDITAR', fornecedorId: e.target.value || null }, 'Fornecedor alterado.')}>
                <option value="">A definir</option>
                {lista.filter((f) => f.categoria !== 'INSTALADOR').map((f) => <option key={f.id} value={f.id}>{f.nomeFantasia}</option>)}
              </select>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline"><a href={`/api/compras/${ordem.id}/pdf`} target="_blank" rel="noopener">PDF da ordem</a></Button>
            {ordem.tipo === 'COSTURA' && <Button asChild size="sm" variant="outline"><a href={`/api/pedidos/${ordem.pedidoId}/producao.pdf?tipo=CORTINA`} target="_blank" rel="noopener">Ficha de corte</a></Button>}
            {ordem.tipo === 'FABRICA' && <Button asChild size="sm" variant="outline"><a href={`/api/pedidos/${ordem.pedidoId}/producao.pdf?tipo=PERSIANA`} target="_blank" rel="noopener">Pedido de fábrica</a></Button>}
            <Button size="sm" variant="outline" onClick={() => whatsapp('ORDEM_COMPRA')}>WhatsApp: ordem</Button>
            {ordem.tipo === 'COSTURA' && <Button size="sm" variant="outline" onClick={() => whatsapp('FICHA_CORTE')}>WhatsApp: ficha de corte</Button>}
            {ordem.tipo === 'FABRICA' && <Button size="sm" variant="outline" onClick={() => whatsapp('PEDIDO_FABRICA')}>WhatsApp: pedido de fábrica</Button>}
          </div>
          <div className="flex flex-wrap items-end gap-2 border-t pt-3">
            {ordem.status === 'ABERTA' && <Button size="sm" disabled={ocupado || !ordem.fornecedorId} onClick={() => agir({ acao: 'ENVIAR' }, `${ordem.numero} enviada.`)}>Marcar como enviada</Button>}
            {(ordem.status === 'ABERTA' || ordem.status === 'ENVIADA') && (
              <>
                <Input className="h-8 w-36" placeholder={`Custo real (${moeda(ordem.custoPrevisto)})`} value={custo} onChange={(e) => setCusto(e.target.value)} />
                <Button size="sm" variant="outline" disabled={ocupado} onClick={() => agir({ acao: 'RECEBER', ...(custo ? { custoReal: custo } : {}) }, `${ordem.numero} recebida.`)}>
                  Chegou / ficou pronto
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" disabled={ocupado} onClick={() => agir({ acao: 'CANCELAR' }, `${ordem.numero} cancelada.`)}>Cancelar</Button>
              </>
            )}
            {(ordem.status === 'RECEBIDA' || ordem.status === 'CANCELADA' || ordem.status === 'ENVIADA') && (
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => agir({ acao: 'REABRIR' }, `${ordem.numero} voltou uma etapa.`)}>Desfazer última etapa</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
