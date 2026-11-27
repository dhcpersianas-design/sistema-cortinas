'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { hojeISO } from '../pedidos/formato';
import { FORMAS_RECEB } from '../financeiro/comum';

type TipoColuna = 'texto' | 'moeda' | 'pct' | 'int' | 'data';
type Linha = Record<string, string | number | null | boolean | undefined> & { _alerta?: boolean; _nivel?: number };
type Relatorio = {
  tipo: string; titulo: string; periodo: string;
  resumo: { rotulo: string; valor: string; tipo: TipoColuna; alerta?: boolean }[];
  tabelas: { titulo?: string; colunas: { chave: string; titulo: string; tipo: TipoColuna }[]; linhas: Linha[]; total?: Linha; vazio?: string }[];
  observacoes: string[];
};
type Meta = { id: string; titulo: string; descricao: string };

function fmt(v: unknown, tipo: TipoColuna): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  const milhar = (x: string) => {
    const neg = x.startsWith('-');
    const [i, d] = (neg ? x.slice(1) : x).split('.');
    return `${neg ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${d !== undefined ? `,${d}` : ''}`;
  };
  if (tipo === 'moeda') return `R$ ${milhar(Number(s).toFixed(2))}`;
  if (tipo === 'pct') return `${milhar(Number(s).toFixed(2))}%`;
  if (tipo === 'int') return milhar(s);
  if (tipo === 'data') return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10).split('-').reverse().join('/') : s;
  return s;
}

const inicioMes = (iso: string) => `${iso.slice(0, 8)}01`;
function fimMes(iso: string) {
  const [a, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(a!, m!, 0)).toISOString().slice(0, 10);
}

export function Relatorios() {
  const [lista, setLista] = useState<Meta[]>([]);
  const [tipo, setTipo] = useState('dre');
  const hoje = hojeISO();
  const [de, setDe] = useState(inicioMes(hoje));
  const [ate, setAte] = useState(hoje);
  const [extra, setExtra] = useState<Record<string, string>>({ regime: 'competencia' });
  const [rel, setRel] = useState<Relatorio | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => { api<{ relatorios: Meta[] }>('/api/relatorios').then((r) => setLista(r.relatorios)).catch((e) => setErro((e as Error).message)); }, []);

  const consulta = (formato?: string) => {
    const p = new URLSearchParams({ de, ate });
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    if (formato) p.set('formato', formato);
    return `/api/relatorios/${tipo}?${p}`;
  };
  async function gerar() {
    setCarregando(true); setErro(null);
    try { setRel((await api<{ relatorio: Relatorio }>(consulta())).relatorio); } catch (e) { setErro((e as Error).message); }
    finally { setCarregando(false); }
  }
  useEffect(() => { setRel(null); }, [tipo]);

  const atalhos: [string, () => void][] = [
    ['Este mês', () => { setDe(inicioMes(hoje)); setAte(fimMes(hoje)); }],
    ['Mês passado', () => { const x = new Date(`${inicioMes(hoje)}T12:00:00Z`); x.setUTCDate(0); const f = x.toISOString().slice(0, 10); setDe(inicioMes(f)); setAte(f); }],
    ['Este ano', () => { setDe(`${hoje.slice(0, 4)}-01-01`); setAte(`${hoje.slice(0, 4)}-12-31`); }],
    ['Próximos 90 dias', () => { setDe(hoje); const x = new Date(`${hoje}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 90); setAte(x.toISOString().slice(0, 10)); }],
  ];
  const campo = (k: string, rotulo: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">{rotulo}
      <Input className="w-44" value={extra[k] ?? ''} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })} {...props} />
    </label>
  );
  const meta = lista.find((r) => r.id === tipo);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Relatórios</h1>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {lista.map((r) => (
          <button key={r.id} onClick={() => setTipo(r.id)}
            className={`rounded-md border p-3 text-left text-sm transition-colors ${tipo === r.id ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}>
            <div className="font-medium">{r.titulo}</div>
            <div className="text-xs text-muted-foreground">{r.descricao}</div>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-end gap-2">
            {tipo !== 'contas' && (tipo !== 'clientes' || extra.usarPeriodo === '1') && (
              <>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">{tipo === 'clientes' ? 'Compra de' : 'De'}<Input type="date" className="w-44" value={de} onChange={(e) => setDe(e.target.value)} /></label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">Até<Input type="date" className="w-44" value={ate} onChange={(e) => setAte(e.target.value)} /></label>
                <div className="flex flex-wrap gap-1">{atalhos.map(([n, f]) => <Button key={n} type="button" size="sm" variant="outline" onClick={f}>{n}</Button>)}</div>
              </>
            )}
            {tipo === 'contas' && <p className="text-sm text-muted-foreground">Posição de hoje.</p>}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {tipo === 'dre' && (
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">Regime
                <select className={`${classeSelect} w-56`} value={extra.regime ?? 'competencia'} onChange={(e) => setExtra({ ...extra, regime: e.target.value })}>
                  <option value="competencia">Competência (pela data da venda)</option>
                  <option value="caixa">Caixa (pelo que entrou e saiu)</option>
                </select>
              </label>
            )}
            {tipo === 'faturamento' && (
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">Agrupar por
                <select className={`${classeSelect} w-40`} value={extra.agrupar ?? ''} onChange={(e) => setExtra({ ...extra, agrupar: e.target.value })}>
                  <option value="">Automático</option><option value="dia">Dia</option><option value="mes">Mês</option><option value="ano">Ano</option>
                </select>
              </label>
            )}
            {tipo === 'clientes' && (
              <>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={extra.usarPeriodo === '1'} onChange={(e) => setExtra({ ...extra, usarPeriodo: e.target.checked ? '1' : '' })} /> Filtrar pela data da compra</label>
                {campo('nome', 'Nome')}{campo('telefone', 'Telefone', { inputMode: 'tel' })}{campo('bairro', 'Bairro')}{campo('produto', 'Produto comprado')}
                {campo('instalacaoDe', 'Instalado de', { type: 'date' })}{campo('instalacaoAte', 'Instalado até', { type: 'date' })}
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">Forma de pagamento
                  <select className={`${classeSelect} w-44`} value={extra.forma ?? ''} onChange={(e) => setExtra({ ...extra, forma: e.target.value })}>
                    <option value="">Todas</option>{FORMAS_RECEB.map(([k, n]) => <option key={k} value={k}>{n}</option>)}<option value="MISTO">Combinado</option>
                  </select>
                </label>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={gerar} disabled={carregando}>{carregando ? 'Gerando…' : 'Ver relatório'}</Button>
            <Button asChild variant="outline"><a href={consulta('pdf')} target="_blank" rel="noopener">Baixar PDF</a></Button>
            <Button asChild variant="outline"><a href={consulta('xlsx')}>Baixar Excel</a></Button>
          </div>
          {meta && !rel && <p className="text-xs text-muted-foreground">{meta.descricao}</p>}
        </CardContent>
      </Card>
      <Mensagens erro={erro} />

      {rel && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{rel.titulo}</h2>
            <p className="text-sm text-muted-foreground">{rel.periodo}</p>
          </div>
          {rel.resumo.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {rel.resumo.map((k) => (
                <div key={k.rotulo} className="rounded-md border bg-card p-2">
                  <div className="text-xs text-muted-foreground">{k.rotulo}</div>
                  <div className={`font-semibold ${k.alerta ? 'text-destructive' : ''}`}>{fmt(k.valor, k.tipo)}</div>
                </div>
              ))}
            </div>
          )}
          {rel.tabelas.map((t, i) => (
            <div key={i} className="space-y-1">
              {t.titulo && <h3 className="font-medium">{t.titulo}</h3>}
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead className="bg-muted/60">
                    <tr>{t.colunas.map((c) => <th key={c.chave} className={`px-2 py-1.5 font-medium ${c.tipo === 'texto' || c.tipo === 'data' ? 'text-left' : 'text-right'}`}>{c.titulo}</th>)}</tr>
                  </thead>
                  <tbody>
                    {t.linhas.length === 0 && <tr><td colSpan={t.colunas.length} className="px-2 py-3 text-muted-foreground">{t.vazio ?? 'Sem dados.'}</td></tr>}
                    {[...t.linhas, ...(t.total ? [{ ...t.total, _total: true }] : [])].map((l, j) => (
                      <tr key={j} className={`border-t ${l._total ? 'bg-muted/40 font-semibold' : l._nivel === 0 ? 'font-semibold' : ''} ${l._alerta ? 'text-destructive' : ''}`}>
                        {t.colunas.map((c, k) => (
                          <td key={c.chave} className={`px-2 py-1 ${c.tipo === 'texto' || c.tipo === 'data' ? 'text-left' : 'whitespace-nowrap text-right'} ${k === 0 && l._nivel === 1 ? 'pl-6' : ''}`}>
                            {fmt(l[c.chave], c.tipo)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {rel.observacoes.map((o) => <p key={o} className="text-xs text-muted-foreground">• {o}</p>)}
        </div>
      )}
    </div>
  );
}
