'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { classeSelect } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { hojeISO } from '../pedidos/formato';
import { moeda } from '../orcamentos/formato';

/** Formas aceitas para receber/pagar (MISTO não é forma de pagamento: é "combinado"). */
export const FORMAS_RECEB: [string, string][] = [
  ['PIX', 'PIX'], ['DINHEIRO', 'Dinheiro'], ['DEBITO', 'Débito'], ['CREDITO_AVISTA', 'Crédito à vista'],
  ['CREDITO_PARCELADO', 'Crédito parcelado'], ['BOLETO', 'Boleto'],
];
export const nomeForma = (f?: string | null) => FORMAS_RECEB.find(([k]) => k === f)?.[1] ?? (f === 'MISTO' ? 'Combinado' : f ? f : '');

export type Lancamento = {
  id: string; tipo: 'RECEITA' | 'DESPESA'; origem: string; descricao: string; pedidoId?: string | null; pedidoNumero?: string | null;
  cliente?: string | null; fornecedor: string | null; fornecedorId?: string | null; forma: string | null; parcela: number; totalParcelas: number;
  valor: string; taxa: string; liquido: string; competencia?: string; vencimento: string; liquidacao: string | null;
  status: 'PREVISTO' | 'LIQUIDADO' | 'CANCELADO'; cartao: boolean; vencido: boolean; editado?: boolean;
  contaCodigo?: string; contaNome?: string; planoContaId?: number; contaFinanceira?: string | null; observacoes?: string | null;
};

export const ORIGEM: Record<string, string> = {
  SINAL: 'Sinal', SALDO: 'Saldo', ADITIVO: 'Aditivo', RECEBIDO: 'Recebido', CARTAO: 'Maquininha', ORDEM_COMPRA: 'Compra',
  INSTALACAO: 'Instalador', COMISSAO: 'Comissão', DEVOLUCAO: 'Devolução', RECORRENTE: 'Despesa fixa', MANUAL: 'Avulso',
};

export function situacao(l: Lancamento): { texto: string; classe: string } {
  if (l.status === 'CANCELADO') return { texto: 'Cancelado', classe: 'bg-muted text-muted-foreground' };
  if (l.status === 'LIQUIDADO') return { texto: l.tipo === 'RECEITA' ? 'Recebido' : 'Pago', classe: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' };
  if (l.cartao) return { texto: 'A cair (cartão)', classe: 'bg-sky-500/10 text-sky-700 dark:text-sky-400' };
  if (l.vencido) return { texto: 'Vencido', classe: 'bg-destructive/10 text-destructive' };
  return { texto: 'Em aberto', classe: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' };
}

export const dataCurta = (v?: string | null) => (v ? v.slice(0, 10).split('-').reverse().join('/') : '');

export const FORMAS_CARTAO_WEB = ['DEBITO', 'CREDITO_AVISTA', 'CREDITO_PARCELADO'];

type Simulacao = { repasse: boolean; cobrado: string; parcelas: number; valorParcela: string; taxaPct?: string };

/**
 * Parcelas e "quanto passar na maquininha" (crédito com a taxa embutida, quando o repasse está ligado).
 * Taxas: só a tabela Visa/Mastercard, para qualquer bandeira (Gabriel, 27/11/2026).
 * `valor` é o quanto abate da dívida do cliente; o cliente paga `cobrado` no cartão.
 */
export function CamposCartao({ forma, valor, parcelas, setParcelas }: {
  forma: string; valor: string; parcelas: number; setParcelas: (n: number) => void;
}) {
  const [sim, setSim] = useState<Simulacao | null>(null);
  const cartao = FORMAS_CARTAO_WEB.includes(forma);
  const v = Number(valor.replace(/\./g, '').replace(',', '.'));
  useEffect(() => {
    if (!cartao || !(v > 0)) { setSim(null); return; }
    const q = new URLSearchParams({ valor: v.toFixed(2), forma, parcelas: String(parcelas) });
    let vivo = true;
    const t = setTimeout(() => {
      api<Simulacao>(`/api/financeiro/simular-cartao?${q}`).then((r) => { if (vivo) setSim(r); }).catch(() => { if (vivo) setSim(null); });
    }, 250);
    return () => { vivo = false; clearTimeout(t); };
  }, [cartao, v, forma, parcelas]);
  if (!cartao) return null;
  return (
    <>
      {forma === 'CREDITO_PARCELADO' && (
        <label className="flex flex-col gap-1">Parcelas
          <select className={classeSelect} value={parcelas} onChange={(e) => setParcelas(Number(e.target.value))}>
            {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}x</option>)}
          </select>
        </label>
      )}
      {sim && (
        <p className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1.5 text-sm sm:col-span-full">
          Passe na maquininha: <strong>{moeda(sim.cobrado)}</strong>
          {sim.parcelas > 1 ? <> ({sim.parcelas}x de <strong>{moeda(sim.valorParcela)}</strong>)</> : null}
          {sim.repasse && Number(sim.cobrado) > v
            ? <span className="block text-xs text-muted-foreground">Já com a taxa da maquininha embutida: a loja recebe {moeda(v.toFixed(2))}, como no PIX. Para o cliente, informe só o valor final.</span>
            : forma === 'DEBITO' ? <span className="block text-xs text-muted-foreground">Débito: preço cheio, sem taxa embutida (a taxa fica por conta da loja).</span> : null}
        </p>
      )}
    </>
  );
}

/** Receber do cliente (cobrança de um pedido): valor, forma, parcelas e bandeira no cartão, data. */
export function FormReceber({ pedidoId, lancamentoId, valorPadrao, formaPadrao, onFeito, onErro, onCancelar }: {
  pedidoId: string; lancamentoId?: string; valorPadrao: string; formaPadrao?: string | null;
  onFeito: (msg: string) => void; onErro: (m: string) => void; onCancelar?: () => void;
}) {
  const [forma, setForma] = useState(formaPadrao && formaPadrao !== 'MISTO' ? formaPadrao : 'PIX');
  const [valor, setValor] = useState(valorPadrao.replace('.', ','));
  const [parcelas, setParcelas] = useState(3);
  const [ocupado, setOcupado] = useState(false);
  const cartao = FORMAS_CARTAO_WEB.includes(forma);
  return (
    <form className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-3 lg:grid-cols-6" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      setOcupado(true);
      try {
        const r = await api<{ emAbertoDepois: string; cobrado: string }>(`/api/pedidos/${pedidoId}/receber`, {
          method: 'POST',
          corpo: {
            valor, forma, parcelas: forma === 'CREDITO_PARCELADO' ? parcelas : undefined,
            data: f.get('data'), lancamentoId,
          },
        });
        onFeito(`Recebimento registrado. O cliente ainda deve ${moeda(r.emAbertoDepois)}.`);
      } catch (x) { onErro((x as Error).message); }
      finally { setOcupado(false); }
    }}>
      <label className="flex flex-col gap-1">Valor (abate da dívida)<Input inputMode="decimal" required value={valor} onChange={(e) => setValor(e.target.value)} /></label>
      <label className="flex flex-col gap-1">Forma
        <select className={classeSelect} value={forma} onChange={(e) => setForma(e.target.value)}>
          {FORMAS_RECEB.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
      </label>
      <CamposCartao forma={forma} valor={valor} parcelas={parcelas} setParcelas={setParcelas} />
      <label className="flex flex-col gap-1">Data<Input type="date" name="data" required defaultValue={hojeISO()} /></label>
      <div className="flex items-end gap-2">
        <Button disabled={ocupado}>Receber</Button>
        {onCancelar && <Button type="button" variant="ghost" onClick={onCancelar}>Fechar</Button>}
      </div>
      {cartao && (
        <p className="text-xs text-muted-foreground sm:col-span-full">No cartão o cliente fica quitado na hora; o sistema lança os repasses da maquininha e marca cada um como recebido no dia em que cai.</p>
      )}
    </form>
  );
}

/** Dar baixa num lançamento (pagar uma conta ou marcar uma receita avulsa como recebida). */
export function FormBaixa({ l, contas, onFeito, onErro, onCancelar }: {
  l: Lancamento; contas: { id: string; nome: string; ativo: boolean }[];
  onFeito: (m: string) => void; onErro: (m: string) => void; onCancelar: () => void;
}) {
  const [ocupado, setOcupado] = useState(false);
  return (
    <form className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-4" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      setOcupado(true);
      try {
        await api(`/api/financeiro/lancamentos/${l.id}/liquidar`, { method: 'POST', corpo: { data: f.get('data'), valor: f.get('valor'), contaFinanceiraId: f.get('conta') || null } });
        onFeito(l.tipo === 'RECEITA' ? 'Marcado como recebido.' : 'Conta paga.');
      } catch (x) { onErro((x as Error).message); }
      finally { setOcupado(false); }
    }}>
      <label className="flex flex-col gap-1">Valor {l.tipo === 'RECEITA' ? 'recebido' : 'pago'}<Input name="valor" inputMode="decimal" required defaultValue={l.valor} /></label>
      <label className="flex flex-col gap-1">Data<Input type="date" name="data" required defaultValue={hojeISO()} /></label>
      <label className="flex flex-col gap-1">{l.tipo === 'RECEITA' ? 'Entrou em' : 'Saiu de'}
        <select name="conta" className={classeSelect} defaultValue="">
          <option value="">Automático</option>
          {contas.filter((c) => c.ativo).map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
      </label>
      <div className="flex items-end gap-2">
        <Button disabled={ocupado}>{l.tipo === 'RECEITA' ? 'Recebido' : 'Pago'}</Button>
        <Button type="button" variant="ghost" onClick={onCancelar}>Fechar</Button>
      </div>
    </form>
  );
}
