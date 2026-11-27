'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Campo, classeSelect, classeTextarea, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { dinheiro } from '@/lib/utils';
import { formatarData } from '@/lib/texto';

type Categoria = { id: number; nome: string; trilho: boolean };
type Produto = {
  id: string; sku: string; nome: string; corColecao: string | null; categoriaId: number; unidade: string;
  custoUnitario: string; precoVendaUnitario: string; metadata: Record<string, unknown>; fornecedorPadraoId: string | null;
  ativo: boolean | null; barras: { tamanhoM: number; custo: string; venda: string }[]; tabelaBarrasCompleta: boolean;
};
type Historico = {
  id: string; tamanhoM: number | null; custoAnterior: string | null; custoNovo: string | null; vendaAnterior: string | null;
  vendaNova: string | null; motivo: string | null; alteradoEm: string; alteradoPor: string | null;
};

/** Valor da API ("42.5000") para o campo, sem zeros sobrando e sem perder casas: "42,50", "0,3525". */
function paraCampo(v: string | null | undefined): string {
  if (v == null) return '';
  const [inteiro, dec = ''] = v.split('.');
  return `${inteiro},${dec.replace(/0+$/, '').padEnd(2, '0')}`;
}

export function EditorProduto({ id }: { id: string | null }) {
  const router = useRouter();
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [markup, setMarkup] = useState('100');
  const [fornecedores, setFornecedores] = useState<{ id: string; nomeFantasia: string }[]>([]);
  const [produto, setProduto] = useState<Produto | null>(null);
  const [historico, setHistorico] = useState<Historico[]>([]);
  const [categoriaId, setCategoriaId] = useState('');
  const [custo, setCusto] = useState('');
  const [venda, setVenda] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    api<{ categorias: Categoria[]; markupPadraoPct: string }>('/api/catalogo/categorias')
      .then((r) => { setCategorias(r.categorias); setMarkup(String(Number(r.markupPadraoPct))); });
    api<{ fornecedores: { id: string; nomeFantasia: string }[] }>('/api/fornecedores').then((r) => setFornecedores(r.fornecedores)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!id) return;
    api<{ produto: Produto; historico: Historico[] }>(`/api/catalogo/produtos/${id}`).then((r) => {
      setProduto(r.produto); setHistorico(r.historico ?? []);
      setCategoriaId(String(r.produto.categoriaId)); setCusto(paraCampo(r.produto.custoUnitario)); setVenda(paraCampo(r.produto.precoVendaUnitario));
    }).catch((e) => setErro((e as Error).message));
  }, [id, versao]);

  async function sugerir() {
    if (!custo) return;
    try {
      const r = await api<{ precoVendaSugerido: string }>(`/api/catalogo/preco-sugerido?custo=${encodeURIComponent(custo)}`);
      setVenda(paraCampo(r.precoVendaSugerido));
    } catch (e) { setErro((e as Error).message); }
  }

  async function salvar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null); setOk(null);
    const f = new FormData(e.currentTarget);
    let metadataTecnica: unknown;
    try { metadataTecnica = JSON.parse(String(f.get('metadata') || '{}')); } catch { setErro('Dados técnicos: JSON inválido.'); return; }
    const corpo = {
      sku: f.get('sku'), nome: f.get('nome'), corColecao: f.get('corColecao'), categoriaId: Number(categoriaId),
      unidadeMedida: f.get('unidadeMedida'), custoUnitario: custo, precoVendaUnitario: venda || null,
      fornecedorPadraoId: f.get('fornecedorPadraoId') || null, metadataTecnica, motivo: f.get('motivo') || null,
    };
    try {
      if (id) {
        const r = await api<{ historicoRegistrado: boolean }>(`/api/catalogo/produtos/${id}`, { method: 'PATCH', corpo });
        setOk(r.historicoRegistrado ? 'Salvo. Mudança de preço registrada no histórico.' : 'Salvo.');
        setVersao((v) => v + 1);
      } else {
        const r = await api<{ id: string }>('/api/catalogo/produtos', { method: 'POST', corpo });
        router.replace(`/catalogo/${r.id}`);
      }
    } catch (err) { setErro((err as Error).message); }
  }

  async function alternarAtivo() {
    if (!produto) return;
    try { await api(`/api/catalogo/produtos/${produto.id}`, { method: 'PATCH', corpo: { ativo: !produto.ativo } }); setVersao((v) => v + 1); }
    catch (err) { setErro((err as Error).message); }
  }

  if (id && !produto) return erro ? <Mensagens erro={erro} /> : <p className="text-sm text-muted-foreground">Carregando…</p>;
  const ehTrilho = categorias.find((c) => String(c.id) === categoriaId)?.trilho ?? false;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/catalogo">← Catálogo</Link></Button>
        <h1 className="flex-1 text-xl font-semibold">{produto ? `${produto.sku} · ${produto.nome}` : 'Novo produto'}</h1>
        {produto && <Button variant="outline" size="sm" onClick={alternarAtivo}>{produto.ativo ? 'Inativar' : 'Reativar'}</Button>}
      </div>
      <Mensagens erro={erro} ok={ok} />

      <Card>
        <CardContent className="pt-5">
          <form key={produto?.id ?? 'novo'} onSubmit={salvar} className="grid gap-4 sm:grid-cols-2">
            <Campo rotulo="SKU *" nome="sku" required defaultValue={produto?.sku} className="uppercase" placeholder="TEC-010" />
            <Campo rotulo="Nome *" nome="nome" required defaultValue={produto?.nome} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="categoriaId">Categoria *</Label>
              <select id="categoriaId" required value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} className={classeSelect}>
                <option value="" disabled>Escolha…</option>
                {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="unidadeMedida">Unidade *</Label>
              <select id="unidadeMedida" name="unidadeMedida" required defaultValue={produto?.unidade ?? 'ML'} className={classeSelect}>
                <option value="ML">ML (metro linear)</option><option value="M2">M² (metro quadrado)</option>
                <option value="UN">UN (unidade)</option><option value="PC">PC (peça)</option>
              </select>
            </div>
            <Campo rotulo="Cor / coleção" nome="corColecao" defaultValue={produto?.corColecao ?? ''} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fornecedorPadraoId">Fornecedor padrão</Label>
              <select id="fornecedorPadraoId" name="fornecedorPadraoId" defaultValue={produto?.fornecedorPadraoId ?? ''} className={classeSelect}>
                <option value="">—</option>
                {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nomeFantasia}</option>)}
              </select>
            </div>
            <Campo rotulo="Custo unitário (R$) *" nome="custo" required inputMode="decimal" value={custo} onChange={(e) => setCusto(e.target.value)} placeholder="0,00" />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="venda">Venda unitária (R$)</Label>
              <div className="flex gap-2">
                <Input id="venda" inputMode="decimal" value={venda} onChange={(e) => setVenda(e.target.value)} placeholder={`em branco = custo + ${markup}%`} />
                <Button type="button" variant="outline" onClick={sugerir} disabled={!custo}>Sugerir</Button>
              </div>
              <span className="text-xs text-muted-foreground">Markup padrão {markup}% (venda = custo × {1 + Number(markup) / 100})</span>
            </div>
            <Campo rotulo="Motivo da mudança de preço" nome="motivo" largo placeholder="Ex.: reajuste do fornecedor (vai para o histórico)" />
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="metadata">Dados técnicos (JSON usado pelo cálculo)</Label>
              <textarea id="metadata" name="metadata" defaultValue={JSON.stringify(produto?.metadata ?? {}, null, 2)} className={`${classeTextarea} font-mono text-xs`} />
            </div>
            <div className="sm:col-span-2"><Button type="submit">Salvar produto</Button></div>
          </form>
        </CardContent>
      </Card>

      {produto && ehTrilho && <TabelaBarras produto={produto} markup={markup} onSalvo={() => setVersao((v) => v + 1)} />}

      {produto && (
        <Card>
          <CardHeader><CardTitle>Histórico de preços</CardTitle></CardHeader>
          <CardContent>
            {historico.length === 0 ? <p className="text-sm text-muted-foreground">Sem alterações.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr><th className="py-1 pr-3">Data</th><th className="pr-3">Item</th><th className="pr-3 text-right">Custo</th><th className="pr-3 text-right">Venda</th><th className="pr-3">Por</th><th>Motivo</th></tr>
                  </thead>
                  <tbody>
                    {historico.map((h) => (
                      <tr key={h.id} className="border-t">
                        <td className="py-1 pr-3 whitespace-nowrap">{formatarData(h.alteradoEm)}</td>
                        <td className="pr-3 whitespace-nowrap">{h.tamanhoM ? `Barra ${h.tamanhoM} m` : 'Unitário'}</td>
                        <td className="pr-3 text-right tabular-nums whitespace-nowrap">{h.custoAnterior != null && `${dinheiro(h.custoAnterior)} → `}{h.custoNovo != null ? dinheiro(h.custoNovo) : 'removido'}</td>
                        <td className="pr-3 text-right tabular-nums whitespace-nowrap">{h.vendaAnterior != null && `${dinheiro(h.vendaAnterior)} → `}{h.vendaNova != null ? dinheiro(h.vendaNova) : 'removido'}</td>
                        <td className="pr-3">{h.alteradoPor}</td>
                        <td>{h.motivo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Tabela de preço por tamanho de barra (1 a 6 m), preenchida pelo Gabriel. */
function TabelaBarras({ produto, markup, onSalvo }: { produto: Produto; markup: string; onSalvo: () => void }) {
  const inicial = () => Object.fromEntries([1, 2, 3, 4, 5, 6].map((t) => {
    const b = produto.barras.find((x) => x.tamanhoM === t);
    return [t, { custo: paraCampo(b?.custo), venda: paraCampo(b?.venda) }];
  }));
  const [linhas, setLinhas] = useState<Record<number, { custo: string; venda: string }>>(inicial);
  const [motivo, setMotivo] = useState('');
  const [msg, setMsg] = useState<{ erro?: string; ok?: string; avisos?: string[] }>({});

  useEffect(() => { setLinhas(inicial()); }, [produto]); // eslint-disable-line react-hooks/exhaustive-deps

  const mudar = (t: number, campo: 'custo' | 'venda', v: string) => setLinhas((l) => ({ ...l, [t]: { ...l[t]!, [campo]: v } }));

  async function salvar() {
    setMsg({});
    const barras = [1, 2, 3, 4, 5, 6].map((t) => ({ tamanhoM: t, custo: linhas[t]!.custo || null, venda: linhas[t]!.venda || null }));
    try {
      const r = await api<{ alteracoes: number; avisos: string[] }>(`/api/catalogo/produtos/${produto.id}/barras`, { method: 'PUT', corpo: { barras, motivo: motivo || null } });
      setMsg({ ok: r.alteracoes ? `${r.alteracoes} tamanho(s) alterado(s).` : 'Nada mudou.', avisos: r.avisos });
      setMotivo('');
      onSalvo();
    } catch (e) { setMsg({ erro: (e as Error).message }); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preço por tamanho de barra</CardTitle>
        <CardDescription>
          O trilho é vendido em barras: 6 m quantas couberem + o resto arredondado para a barra inteira (6,10 m = 6 m + 1 m).
          Preencha os 6 tamanhos; enquanto faltar algum, o cálculo cobra por metro. Venda em branco = custo + {markup}%.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-[3.5rem_1fr_1fr] items-center gap-2 text-sm">
          <span className="text-muted-foreground">Barra</span><span className="text-muted-foreground">Custo (R$)</span><span className="text-muted-foreground">Venda (R$)</span>
          {[1, 2, 3, 4, 5, 6].map((t) => (
            <div key={t} className="contents">
              <span className="font-medium">{t} m</span>
              <Input inputMode="decimal" aria-label={`Custo barra ${t} m`} value={linhas[t]!.custo} onChange={(e) => mudar(t, 'custo', e.target.value)} />
              <Input inputMode="decimal" aria-label={`Venda barra ${t} m`} value={linhas[t]!.venda} onChange={(e) => mudar(t, 'venda', e.target.value)} placeholder="sugerida" />
            </div>
          ))}
        </div>
        <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (opcional, vai para o histórico)" />
        <Mensagens erro={msg.erro} ok={msg.ok} avisos={msg.avisos} />
        <Button onClick={salvar} className="self-start">Salvar tabela de barras</Button>
      </CardContent>
    </Card>
  );
}
