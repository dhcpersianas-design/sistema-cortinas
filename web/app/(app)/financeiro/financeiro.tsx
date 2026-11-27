'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { moeda } from '../orcamentos/formato';
import { hojeISO } from '../pedidos/formato';
import { dataCurta, FormBaixa, FormReceber, nomeForma, ORIGEM, situacao, type Lancamento } from './comum';
import { Configuracoes, type Config } from './configuracoes';

type Mei = { ano: string; limite: string; vendido: string; recebido: string; usadoPct: string; restante: string; nivel: 'OK' | 'ALERTA' | 'ESTOUROU'; mensagem: string | null; alertaPct: string };
type Resumo = {
  hoje: string; faixas: Record<string, string>; saldo: string; mei: Mei; pendencias: string[];
  contas: { id: string; nome: string; saldo: string; ativo: boolean }[];
  semNota: { id: string; numero: string }[];
  instaladosComSaldo: { id: string; numero: string; cliente: string; saldo: string }[];
};

const ABAS = [['resumo', 'Resumo'], ['receber', 'A receber'], ['pagar', 'A pagar'], ['config', 'Configurar']] as const;

export function Financeiro() {
  const [aba, setAba] = useState<(typeof ABAS)[number][0]>('resumo');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Financeiro</h1>
      <div className="flex gap-1 overflow-x-auto border-b">
        {ABAS.map(([k, n]) => (
          <button key={k} onClick={() => setAba(k)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${aba === k ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}>{n}</button>
        ))}
      </div>
      {aba === 'resumo' && <PainelResumo irPara={setAba} />}
      {aba === 'receber' && <Lista tipo="RECEITA" />}
      {aba === 'pagar' && <Lista tipo="DESPESA" />}
      {aba === 'config' && <Configuracoes />}
    </div>
  );
}

// ------------------------------------------------------------------ resumo

export function BarraMei({ mei }: { mei: Mei }) {
  const usado = Math.min(100, Number(mei.usadoPct));
  const cor = mei.nivel === 'ESTOUROU' ? 'bg-destructive' : mei.nivel === 'ALERTA' ? 'bg-amber-500' : 'bg-emerald-600';
  return (
    <div className="space-y-1 text-sm">
      <div className="flex justify-between"><span>Limite do MEI {mei.ano}</span><span className="font-medium">{Number(mei.usadoPct).toFixed(0)}% de {moeda(mei.limite)}</span></div>
      <div className="h-3 overflow-hidden rounded-full bg-muted"><div className={`h-full ${cor}`} style={{ width: `${usado}%` }} /></div>
      <p className="text-xs text-muted-foreground">Vendido no ano: {moeda(mei.vendido)} · Recebido no ano: {moeda(mei.recebido)} · Ainda cabe: {moeda(mei.restante)}</p>
      {mei.mensagem && <p className={`rounded-md px-3 py-2 ${mei.nivel === 'ESTOUROU' ? 'bg-destructive/10 text-destructive' : 'bg-amber-500/10 text-amber-800 dark:text-amber-300'}`}>{mei.mensagem}</p>}
    </div>
  );
}

function PainelResumo({ irPara }: { irPara: (a: 'receber' | 'pagar' | 'config') => void }) {
  const [r, setR] = useState<Resumo | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => { api<Resumo>('/api/financeiro/resumo').then(setR).catch((e) => setErro((e as Error).message)); }, []);
  if (!r) return erro ? <Mensagens erro={erro} /> : <p className="text-sm text-muted-foreground">Carregando…</p>;
  const f = r.faixas;
  const Bloco = ({ titulo, k, onClick }: { titulo: string; k: 'receber' | 'pagar'; onClick: () => void }) => (
    <Card className="cursor-pointer transition-colors hover:bg-muted/50" onClick={onClick}>
      <CardHeader><CardTitle>{titulo}</CardTitle></CardHeader>
      <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
        <Valor r="Vencido" v={f[`${k}Vencido`]!} alerta={Number(f[`${k}Vencido`]) > 0} />
        <Valor r="Vence hoje" v={f[`${k}Hoje`]!} />
        <Valor r="Próximos 7 dias" v={f[`${k}7`]!} />
        <Valor r="Próximos 30 dias" v={f[`${k}30`]!} />
        <div className="border-t sm:col-span-2 pt-2"><Valor r="Total em aberto" v={f[`${k}Total`]!} forte /></div>
      </CardContent>
    </Card>
  );
  return (
    <div className="space-y-4">
      {r.pendencias.map((p) => <p key={p} className="cursor-pointer rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" onClick={() => irPara('config')}>{p}</p>)}
      <Card><CardContent className="pt-4"><BarraMei mei={r.mei} /></CardContent></Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Bloco titulo="A receber dos clientes" k="receber" onClick={() => irPara('receber')} />
        <Bloco titulo="A pagar" k="pagar" onClick={() => irPara('pagar')} />
      </div>
      <Card>
        <CardHeader><CardTitle>Dinheiro em caixa e banco</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {r.contas.filter((c) => c.ativo).map((c) => <Valor key={c.id} r={c.nome} v={c.saldo} />)}
          <Valor r="A cair da maquininha" v={f.maquininha!} />
          <div className="border-t pt-1"><Valor r="Total em caixa e banco" v={r.saldo} forte alerta={Number(r.saldo) < 0} /></div>
          <p className="text-xs text-muted-foreground">Calculado pelo saldo inicial de cada conta (Configurar) mais tudo o que foi recebido e pago no sistema.</p>
        </CardContent>
      </Card>
      {r.instaladosComSaldo.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Já instalados e com saldo em aberto</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {r.instaladosComSaldo.map((p) => (
              <Link key={p.id} href={`/pedidos?p=${p.id}`} className="flex justify-between gap-2 border-b py-1 hover:bg-muted">
                <span>{p.numero} · {p.cliente}</span><span className="font-medium text-destructive">{moeda(p.saldo)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
      {r.semNota.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Instalados sem nota fiscal registrada</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-sm">
            {r.semNota.map((p) => <Link key={p.id} href={`/pedidos?p=${p.id}`} className="rounded border px-2 py-1 hover:bg-muted">{p.numero}</Link>)}
            <p className="w-full text-xs text-muted-foreground">Emita a nota no portal do governo e registre o número no pedido.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Valor({ r, v, forte, alerta }: { r: string; v: string; forte?: boolean; alerta?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{r}</span>
      <span className={`${forte ? 'font-semibold' : ''} ${alerta ? 'text-destructive' : ''}`}>{moeda(v)}</span>
    </div>
  );
}

// ------------------------------------------------------------------ listas (a receber / a pagar)

function Lista({ tipo }: { tipo: 'RECEITA' | 'DESPESA' }) {
  const [situacaoF, setSituacaoF] = useState('ABERTO');
  const [q, setQ] = useState('');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [dados, setDados] = useState<{ lancamentos: Lancamento[]; total: string } | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [aberto, setAberto] = useState<{ id: string; modo: 'baixa' | 'receber' | 'editar' } | null>(null);
  const [novo, setNovo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const p = new URLSearchParams({ tipo, situacao: situacaoF, ...(q ? { q } : {}), ...(de ? { de } : {}), ...(ate ? { ate } : {}) });
    try { setDados(await api(`/api/financeiro/lancamentos?${p}`)); } catch (e) { setErro((e as Error).message); }
  }, [tipo, situacaoF, q, de, ate]);
  useEffect(() => { const t = setTimeout(carregar, q ? 300 : 0); return () => clearTimeout(t); }, [carregar, q]);
  useEffect(() => { api<Config>('/api/financeiro/config').then(setConfig).catch(() => null); }, []);

  const feito = (m: string) => { setOk(m); setErro(null); setAberto(null); setNovo(false); carregar(); };
  const falha = (m: string) => { setErro(m); setOk(null); };
  async function acao(id: string, caminho: string, msg: string) {
    try { await api(`/api/financeiro/lancamentos/${id}/${caminho}`, { method: 'POST', corpo: {} }); feito(msg); } catch (e) { falha((e as Error).message); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <select className={`${classeSelect} w-44`} value={situacaoF} onChange={(e) => setSituacaoF(e.target.value)}>
          <option value="ABERTO">Em aberto</option><option value="VENCIDO">Vencidos</option>
          <option value="PAGO">{tipo === 'RECEITA' ? 'Recebidos' : 'Pagos'}</option><option value="TODOS">Todos</option><option value="CANCELADO">Cancelados</option>
        </select>
        <Input className="w-56" placeholder={tipo === 'RECEITA' ? 'Buscar cliente, pedido…' : 'Buscar fornecedor, descrição…'} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex flex-col text-xs text-muted-foreground">{situacaoF === 'PAGO' ? 'Pago de' : 'Vence de'}<Input type="date" className="w-40" value={de} onChange={(e) => setDe(e.target.value)} /></label>
        <label className="flex flex-col text-xs text-muted-foreground">até<Input type="date" className="w-40" value={ate} onChange={(e) => setAte(e.target.value)} /></label>
        <span className="flex-1" />
        <Button onClick={() => setNovo(!novo)}>{tipo === 'RECEITA' ? 'Nova receita avulsa' : 'Nova conta a pagar'}</Button>
      </div>
      <Mensagens erro={erro} ok={ok} />
      {novo && config && <NovoLancamento tipo={tipo} config={config} onFeito={feito} onErro={falha} />}
      {tipo === 'RECEITA' && <p className="text-xs text-muted-foreground">As cobranças dos pedidos (sinal e saldo) nascem sozinhas quando o cliente aprova o orçamento.</p>}
      {tipo === 'DESPESA' && <p className="text-xs text-muted-foreground">Compras, costura, fábrica, instalador, comissão e despesas fixas entram sozinhos. Aqui você lança o resto (aluguel avulso, frete…).</p>}
      {dados && (
        <div className="space-y-2">
          <p className="text-sm">{dados.lancamentos.length} lançamento(s) · total <strong>{moeda(dados.total)}</strong></p>
          {dados.lancamentos.length === 0 && <p className="text-sm text-muted-foreground">Nada por aqui.</p>}
          {dados.lancamentos.map((l) => {
            const s = situacao(l);
            const cobranca = l.tipo === 'RECEITA' && l.pedidoId && !l.cartao;
            return (
              <div key={l.id} className="rounded-md border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{l.descricao}</div>
                    <div className="text-xs text-muted-foreground">
                      {[l.cliente ?? l.fornecedor, ORIGEM[l.origem], l.contaCodigo && `${l.contaCodigo} ${l.contaNome}`, l.forma && nomeForma(l.forma), l.contaFinanceira].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">{moeda(l.valor)}</div>
                    {Number(l.taxa) > 0 && <div className="text-xs text-muted-foreground">taxa {moeda(l.taxa)} · líquido {moeda(l.liquido)}</div>}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge className={s.classe}>{s.texto}</Badge>
                  <span className="text-xs text-muted-foreground">{l.status === 'LIQUIDADO' ? `em ${dataCurta(l.liquidacao)}` : `vence ${dataCurta(l.vencimento)}`}</span>
                  {l.pedidoId && <Link className="text-xs underline" href={`/pedidos?p=${l.pedidoId}`}>{l.pedidoNumero}</Link>}
                  <span className="flex-1" />
                  {l.status === 'PREVISTO' && cobranca && <Button size="sm" onClick={() => setAberto({ id: l.id, modo: 'receber' })}>Receber</Button>}
                  {l.status === 'PREVISTO' && !cobranca && !l.cartao && <Button size="sm" onClick={() => setAberto({ id: l.id, modo: 'baixa' })}>{l.tipo === 'RECEITA' ? 'Recebido' : 'Pagar'}</Button>}
                  {l.status === 'PREVISTO' && !l.cartao && <Button size="sm" variant="outline" onClick={() => setAberto({ id: l.id, modo: 'editar' })}>Editar</Button>}
                  {l.status === 'PREVISTO' && !l.cartao && <Button size="sm" variant="ghost" onClick={() => acao(l.id, 'cancelar', 'Lançamento cancelado.')}>Cancelar</Button>}
                  {(l.status === 'LIQUIDADO' || l.cartao) && <Button size="sm" variant="ghost" onClick={() => acao(l.id, 'desfazer', l.tipo === 'RECEITA' && l.pedidoId ? 'Recebimento desfeito: voltou a ser cobrado do cliente.' : 'Pagamento desfeito.')}>Desfazer</Button>}
                </div>
                {aberto?.id === l.id && aberto.modo === 'receber' && l.pedidoId && (
                  <div className="mt-2"><FormReceber pedidoId={l.pedidoId} lancamentoId={l.id} valorPadrao={l.valor} formaPadrao={l.forma} onFeito={feito} onErro={falha} onCancelar={() => setAberto(null)} /></div>
                )}
                {aberto?.id === l.id && aberto.modo === 'baixa' && config && (
                  <div className="mt-2"><FormBaixa l={l} contas={config.contas} onFeito={feito} onErro={falha} onCancelar={() => setAberto(null)} /></div>
                )}
                {aberto?.id === l.id && aberto.modo === 'editar' && config && (
                  <div className="mt-2"><EditarLancamento l={l} config={config} onFeito={feito} onErro={falha} onCancelar={() => setAberto(null)} /></div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function contasDoTipo(config: Config, tipo: 'RECEITA' | 'DESPESA') {
  return config.planoContas.filter((c) => (tipo === 'RECEITA' ? c.grupo === 'RECEITA' : c.grupo !== 'RECEITA'));
}

function NovoLancamento({ tipo, config, onFeito, onErro }: { tipo: 'RECEITA' | 'DESPESA'; config: Config; onFeito: (m: string) => void; onErro: (m: string) => void }) {
  const [fornecedores, setFornecedores] = useState<{ id: string; nomeFantasia: string }[]>([]);
  const [pago, setPago] = useState(false);
  useEffect(() => { if (tipo === 'DESPESA') api<{ fornecedores: { id: string; nomeFantasia: string }[] }>('/api/fornecedores').then((r) => setFornecedores(r.fornecedores)).catch(() => null); }, [tipo]);
  return (
    <form className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-3" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        await api('/api/financeiro/lancamentos', {
          method: 'POST', corpo: {
            tipo, descricao: f.get('descricao'), planoContaId: Number(f.get('conta')), valor: f.get('valor'), vencimento: f.get('vencimento'),
            fornecedorId: f.get('fornecedor') || null, pago: pago ? { data: f.get('pagoEm') } : null,
          },
        });
        onFeito('Lançamento criado.');
      } catch (x) { onErro((x as Error).message); }
    }}>
      <label className="flex flex-col gap-1 sm:col-span-2">Descrição<Input name="descricao" required placeholder={tipo === 'RECEITA' ? 'Ex.: conserto de persiana' : 'Ex.: frete, material de escritório'} /></label>
      <label className="flex flex-col gap-1">Valor<Input name="valor" inputMode="decimal" required /></label>
      <label className="flex flex-col gap-1">Categoria (plano de contas)
        <select name="conta" className={classeSelect} required>
          {contasDoTipo(config, tipo).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nome}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">Vencimento<Input type="date" name="vencimento" required defaultValue={hojeISO()} /></label>
      {tipo === 'DESPESA' ? (
        <label className="flex flex-col gap-1">Fornecedor (opcional)
          <select name="fornecedor" className={classeSelect} defaultValue="">
            <option value="">-</option>
            {fornecedores.map((x) => <option key={x.id} value={x.id}>{x.nomeFantasia}</option>)}
          </select>
        </label>
      ) : <span />}
      <label className="flex items-center gap-2"><input type="checkbox" checked={pago} onChange={(e) => setPago(e.target.checked)} /> Já {tipo === 'RECEITA' ? 'recebido' : 'pago'}</label>
      {pago && <label className="flex flex-col gap-1">Em<Input type="date" name="pagoEm" defaultValue={hojeISO()} /></label>}
      <div className="flex items-end sm:col-span-3"><Button>Salvar</Button></div>
    </form>
  );
}

function EditarLancamento({ l, config, onFeito, onErro, onCancelar }: { l: Lancamento; config: Config; onFeito: (m: string) => void; onErro: (m: string) => void; onCancelar: () => void }) {
  return (
    <form className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-4" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        await api(`/api/financeiro/lancamentos/${l.id}`, {
          method: 'PUT', corpo: { descricao: f.get('descricao'), valor: f.get('valor'), vencimento: f.get('vencimento'), planoContaId: Number(f.get('conta')) },
        });
        onFeito('Lançamento alterado. O sistema não mexe mais nele sozinho.');
      } catch (x) { onErro((x as Error).message); }
    }}>
      <label className="flex flex-col gap-1 sm:col-span-2">Descrição<Input name="descricao" defaultValue={l.descricao} required /></label>
      <label className="flex flex-col gap-1">Valor<Input name="valor" inputMode="decimal" defaultValue={l.valor} required /></label>
      <label className="flex flex-col gap-1">Vencimento<Input type="date" name="vencimento" defaultValue={l.vencimento} required /></label>
      <label className="flex flex-col gap-1 sm:col-span-2">Categoria
        <select name="conta" className={classeSelect} defaultValue={l.planoContaId}>
          {contasDoTipo(config, l.tipo).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nome}</option>)}
        </select>
      </label>
      <div className="flex items-end gap-2 sm:col-span-2"><Button>Salvar</Button><Button type="button" variant="ghost" onClick={onCancelar}>Fechar</Button></div>
    </form>
  );
}
