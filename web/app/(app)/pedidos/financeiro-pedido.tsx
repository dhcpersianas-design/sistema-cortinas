'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { moeda, pct } from '../orcamentos/formato';
import { dataCurta, FormReceber, nomeForma, ORIGEM, situacao, type Lancamento } from '../financeiro/comum';

export type LucroPedido = {
  venda: string; custoPrevisto: string; custoReal: string; custoEstimado: boolean; desvio: string;
  taxas: string; imposto: string; comissao: string; lucro: string; margemPct: string; margemPrevistaPct: string; alertas: string[];
};
export type FinanceiroDoPedido = { lancamentos: Lancamento[]; lucro: LucroPedido | null };

/** Contas a receber, a pagar e lucro real do pedido (só ADMIN). */
export function FinanceiroPedido({ pedidoId, fin, saldo, forma, cancelado, onMudou, onErro }: {
  pedidoId: string; fin: FinanceiroDoPedido; saldo: string; forma: string | null; cancelado: boolean;
  onMudou: (msg: string) => void; onErro: (m: string) => void;
}) {
  const [receber, setReceber] = useState<string | null>(null);
  const rec = fin.lancamentos.filter((l) => l.tipo === 'RECEITA');
  const pag = fin.lancamentos.filter((l) => l.tipo === 'DESPESA');
  const l = fin.lucro;
  const linha = (x: Lancamento) => {
    const s = situacao(x);
    const cobranca = x.tipo === 'RECEITA' && !x.cartao && x.status === 'PREVISTO';
    return (
      <div key={x.id} className="border-b py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">
            {ORIGEM[x.origem] ?? x.origem}{x.totalParcelas > 1 ? ` ${x.parcela}/${x.totalParcelas}` : ''}
            <span className="block text-xs text-muted-foreground">
              {[x.fornecedor, x.forma && nomeForma(x.forma), x.status === 'LIQUIDADO' ? `em ${dataCurta(x.liquidacao)}` : `vence ${dataCurta(x.vencimento)}`,
                Number(x.taxa) > 0 ? `taxa ${moeda(x.taxa)}` : null].filter(Boolean).join(' · ')}
            </span>
          </span>
          <Badge className={s.classe}>{s.texto}</Badge>
          <span className="w-28 text-right font-medium">{moeda(x.valor)}</span>
          {cobranca && !cancelado && <Button size="sm" onClick={() => setReceber(receber === x.id ? null : x.id)}>Receber</Button>}
        </div>
        {receber === x.id && (
          <div className="mt-2">
            <FormReceber pedidoId={pedidoId} lancamentoId={x.id} valorPadrao={x.valor} formaPadrao={x.forma ?? forma}
              onFeito={(m) => { setReceber(null); onMudou(m); }} onErro={onErro} onCancelar={() => setReceber(null)} />
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      <Card>
        <CardHeader><CardTitle>Recebimentos do cliente</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {rec.length === 0 && <p className="text-muted-foreground">Sem cobranças.</p>}
          {rec.map(linha)}
          <div className="flex justify-between pt-2 font-semibold"><span>Cliente ainda deve</span><span className={Number(saldo) > 0 ? 'text-destructive' : ''}>{moeda(saldo)}</span></div>
        </CardContent>
      </Card>
      {pag.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Contas a pagar deste pedido</CardTitle></CardHeader>
          <CardContent className="text-sm">{pag.map(linha)}<p className="pt-2 text-xs text-muted-foreground">Pague em Financeiro &gt; A pagar.</p></CardContent>
        </Card>
      )}
      {l && (
        <Card>
          <CardHeader><CardTitle>Lucro real do pedido</CardTitle></CardHeader>
          <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
            <Par r="Vendido" v={moeda(l.venda)} />
            <Par r="Custo previsto (orçamento)" v={moeda(l.custoPrevisto)} />
            <Par r={`Custo real${l.custoEstimado ? ' (parte ainda prevista)' : ''}`} v={moeda(l.custoReal)} alerta={Number(l.desvio) > 0} />
            <Par r="Diferença no custo" v={`${Number(l.desvio) > 0 ? '+' : ''}${moeda(l.desvio)}`} alerta={Number(l.desvio) > 0} />
            <Par r="Taxas de cartão/boleto" v={moeda(l.taxas)} />
            <Par r="Comissão" v={moeda(l.comissao)} />
            {Number(l.imposto) > 0 && <Par r="Imposto" v={moeda(l.imposto)} />}
            <Par r="Lucro líquido" v={moeda(l.lucro)} forte alerta={Number(l.lucro) < 0} />
            <Par r="Margem real (prevista)" v={`${pct(l.margemPct)} (${pct(l.margemPrevistaPct)})`} forte alerta={l.alertas.length > 0} />
            {l.alertas.map((a) => <p key={a} className="rounded bg-destructive/10 px-2 py-1 text-destructive sm:col-span-2">{a}</p>)}
          </CardContent>
        </Card>
      )}
    </>
  );
}

function Par({ r, v, forte, alerta }: { r: string; v: string; forte?: boolean; alerta?: boolean }) {
  return (
    <div className="flex justify-between gap-2 border-b py-1">
      <span className="text-muted-foreground">{r}</span>
      <span className={`${forte ? 'font-semibold' : ''} ${alerta ? 'text-destructive' : ''}`}>{v}</span>
    </div>
  );
}
