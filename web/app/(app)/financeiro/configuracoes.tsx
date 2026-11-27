'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { moeda } from '../orcamentos/formato';
import { FORMAS_RECEB, nomeForma } from './comum';

export type Config = {
  taxas: { id: number; forma: string; parcelas: number; mdr: string; antecipacao: string; diasRepasse: number }[];
  contas: { id: string; nome: string; tipo: string; saldoInicial: string; saldo: string; ativo: boolean }[];
  recorrentes: { id: number; descricao: string; planoContaId: number; contaCodigo: string; contaNome: string; fornecedorId: string | null; fornecedor: string | null; valor: string; dia: number; inicio: string; ativo: boolean }[];
  planoContas: { id: number; codigo: string; nome: string; grupo: string }[];
  parametros: { chave: string; rotulo: string; dica: string; valor: string | null }[];
};

const TIPO_CONTA: Record<string, string> = { CONTA_CORRENTE: 'Conta no banco', CAIXA: 'Dinheiro (caixa)', MAQUININHA: 'Maquininha' };
const semZeros = (v: string | null) => (v == null ? '' : String(Number(v)).replace('.', ','));

export function Configuracoes() {
  const [c, setC] = useState<Config | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const carregar = useCallback(() => api<Config>('/api/financeiro/config').then(setC).catch((e) => setErro((e as Error).message)), []);
  useEffect(() => { carregar(); }, [carregar]);
  const feito = (m: string) => { setOk(m); setErro(null); carregar(); };
  const falha = (e: unknown) => { setErro((e as Error).message); setOk(null); };
  if (!c) return erro ? <Mensagens erro={erro} /> : <p className="text-sm text-muted-foreground">Carregando…</p>;
  return (
    <div className="space-y-4">
      <Mensagens erro={erro} ok={ok} />
      <Taxas c={c} onFeito={feito} onErro={falha} />
      <Recorrentes c={c} onFeito={feito} onErro={falha} />
      <Contas c={c} onFeito={feito} onErro={falha} />
      <Parametros c={c} onFeito={feito} onErro={falha} />
    </div>
  );
}

type P = { c: Config; onFeito: (m: string) => void; onErro: (e: unknown) => void };

function Taxas({ c, onFeito, onErro }: P) {
  const [nova, setNova] = useState('');
  return (
    <Card>
      <CardHeader><CardTitle>Taxas da maquininha e do boleto</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">Copie da sua maquininha. A taxa entra no cálculo da margem do orçamento e no valor que realmente cai na conta. &quot;Dias para cair&quot; = em quantos dias o dinheiro chega (no parcelado, cada parcela cai 30 dias depois da anterior; com taxa de antecipação, cai tudo junto).</p>
        <form className="space-y-1" onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            await api('/api/financeiro/taxas', { method: 'PUT', corpo: { taxas: c.taxas.map((t) => ({ id: t.id, mdr: f.get(`mdr${t.id}`), antecipacao: f.get(`ant${t.id}`), diasRepasse: Number(f.get(`dias${t.id}`)) })) } });
            onFeito('Taxas salvas.');
          } catch (x) { onErro(x); }
        }}>
          <div className="grid grid-cols-[1fr_5rem_5rem_5rem] gap-2 text-xs text-muted-foreground"><span>Forma</span><span>Taxa %</span><span>Antecip. %</span><span>Dias p/ cair</span></div>
          {c.taxas.map((t) => (
            <div key={t.id} className="grid grid-cols-[1fr_5rem_5rem_5rem] items-center gap-2">
              <span>{nomeForma(t.forma)}{t.forma === 'CREDITO_PARCELADO' ? ` ${t.parcelas}x` : ''}</span>
              <Input name={`mdr${t.id}`} inputMode="decimal" defaultValue={semZeros(t.mdr)} />
              <Input name={`ant${t.id}`} inputMode="decimal" defaultValue={semZeros(t.antecipacao)} />
              <Input name={`dias${t.id}`} inputMode="numeric" defaultValue={t.diasRepasse} />
            </div>
          ))}
          <Button className="mt-2">Salvar taxas</Button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <select className={`${classeSelect} w-52`} value={nova} onChange={(e) => setNova(e.target.value)}>
            <option value="">Incluir parcelado em…</option>
            {Array.from({ length: 12 }, (_, i) => i + 13).map((n) => <option key={n} value={n}>{n}x</option>)}
          </select>
          {nova && <Button variant="outline" onClick={async () => {
            try { await api('/api/financeiro/taxas', { method: 'POST', corpo: { forma: 'CREDITO_PARCELADO', parcelas: Number(nova) } }); setNova(''); onFeito('Linha incluída.'); } catch (x) { onErro(x); }
          }}>Incluir</Button>}
        </div>
      </CardContent>
    </Card>
  );
}

function Recorrentes({ c, onFeito, onErro }: P) {
  const [editando, setEditando] = useState<number | 'nova' | null>(null);
  const contas = c.planoContas.filter((p) => p.grupo === 'DESPESA_FIXA' || p.grupo === 'DESPESA_VARIAVEL');
  const form = (r?: Config['recorrentes'][number]) => (
    <form className="grid gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-6" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const corpo = { descricao: f.get('descricao'), planoContaId: Number(f.get('conta')), valor: f.get('valor'), dia: Number(f.get('dia')), ativo: f.get('ativo') === 'on' };
      try {
        await api(r ? `/api/financeiro/recorrentes/${r.id}` : '/api/financeiro/recorrentes', { method: r ? 'PUT' : 'POST', corpo });
        setEditando(null); onFeito('Despesa fixa salva. Os lançamentos do mês aparecem em A pagar.');
      } catch (x) { onErro(x); }
    }}>
      <label className="flex flex-col gap-1 sm:col-span-2">Descrição<Input name="descricao" required defaultValue={r?.descricao} placeholder="Ex.: Aluguel" /></label>
      <label className="flex flex-col gap-1 sm:col-span-2">Categoria
        <select name="conta" className={classeSelect} defaultValue={r?.planoContaId}>
          {contas.map((p) => <option key={p.id} value={p.id}>{p.codigo} {p.nome}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">Valor<Input name="valor" inputMode="decimal" required defaultValue={r ? r.valor.replace('.', ',') : ''} /></label>
      <label className="flex flex-col gap-1">Vence dia<Input name="dia" inputMode="numeric" required defaultValue={r?.dia ?? 10} /></label>
      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" name="ativo" defaultChecked={r?.ativo ?? true} /> Ligada (lança todo mês)</label>
      <div className="flex gap-2 sm:col-span-4"><Button>Salvar</Button><Button type="button" variant="ghost" onClick={() => setEditando(null)}>Fechar</Button></div>
    </form>
  );
  return (
    <Card>
      <CardHeader><CardTitle>Despesas fixas do mês</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">O sistema lança cada uma em A pagar todo mês (este mês e o próximo). O DAS do MEI já está na lista: informe o valor e ligue.</p>
        {c.recorrentes.map((r) => (
          <div key={r.id}>
            <div className="flex flex-wrap items-center gap-2 border-b py-1">
              <span className="flex-1">{r.descricao} <span className="text-xs text-muted-foreground">({r.contaCodigo} · dia {r.dia})</span></span>
              <span>{moeda(r.valor)}</span>
              <span className={`text-xs ${r.ativo ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}`}>{r.ativo ? 'ligada' : 'desligada'}</span>
              <Button size="sm" variant="outline" onClick={() => setEditando(r.id)}>Editar</Button>
            </div>
            {editando === r.id && form(r)}
          </div>
        ))}
        {editando === 'nova' ? form() : <Button variant="outline" onClick={() => setEditando('nova')}>Nova despesa fixa</Button>}
      </CardContent>
    </Card>
  );
}

function Contas({ c, onFeito, onErro }: P) {
  const [editando, setEditando] = useState<string | null>(null);
  const form = (x?: Config['contas'][number]) => (
    <form className="grid gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-4" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const corpo = { nome: f.get('nome'), tipo: f.get('tipo'), saldoInicial: f.get('saldo') || '0', ativo: f.get('ativo') === 'on' };
      try {
        await api(x ? `/api/financeiro/contas/${x.id}` : '/api/financeiro/contas', { method: x ? 'PUT' : 'POST', corpo });
        setEditando(null); onFeito('Conta salva.');
      } catch (err) { onErro(err); }
    }}>
      <label className="flex flex-col gap-1">Nome<Input name="nome" required defaultValue={x?.nome} /></label>
      <label className="flex flex-col gap-1">Tipo
        <select name="tipo" className={classeSelect} defaultValue={x?.tipo ?? 'CONTA_CORRENTE'}>
          {Object.entries(TIPO_CONTA).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">Saldo no dia em que começou a usar o sistema<Input name="saldo" inputMode="decimal" defaultValue={x ? x.saldoInicial.replace('.', ',') : '0'} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" name="ativo" defaultChecked={x?.ativo ?? true} /> Em uso</label>
      <div className="flex gap-2 sm:col-span-4"><Button>Salvar</Button><Button type="button" variant="ghost" onClick={() => setEditando(null)}>Fechar</Button></div>
    </form>
  );
  return (
    <Card>
      <CardHeader><CardTitle>Contas (onde o dinheiro fica)</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        {c.contas.map((x) => (
          <div key={x.id}>
            <div className="flex flex-wrap items-center gap-2 border-b py-1">
              <span className="flex-1">{x.nome} <span className="text-xs text-muted-foreground">({TIPO_CONTA[x.tipo] ?? x.tipo}{x.ativo ? '' : ', fora de uso'})</span></span>
              <span>saldo {moeda(x.saldo)}</span>
              <Button size="sm" variant="outline" onClick={() => setEditando(x.id)}>Editar</Button>
            </div>
            {editando === x.id && form(x)}
          </div>
        ))}
        {editando === 'nova' ? form() : <Button variant="outline" onClick={() => setEditando('nova')}>Nova conta</Button>}
      </CardContent>
    </Card>
  );
}

function Parametros({ c, onFeito, onErro }: P) {
  return (
    <Card>
      <CardHeader><CardTitle>Regras do negócio</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-3 text-sm sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const valores = Object.fromEntries(c.parametros.map((p) => [p.chave, String(f.get(p.chave) ?? '')]).filter(([, v]) => v !== ''));
          try { await api('/api/financeiro/parametros', { method: 'PUT', corpo: { valores } }); onFeito('Regras salvas. Valem a partir de hoje.'); } catch (x) { onErro(x); }
        }}>
          {c.parametros.map((p) => (
            <label key={p.chave} className="flex flex-col gap-1">{p.rotulo}
              <Input name={p.chave} inputMode="decimal" defaultValue={semZeros(p.valor)} />
              <span className="text-xs text-muted-foreground">{p.dica}</span>
            </label>
          ))}
          <div className="sm:col-span-2"><Button>Salvar regras</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

export { FORMAS_RECEB };
