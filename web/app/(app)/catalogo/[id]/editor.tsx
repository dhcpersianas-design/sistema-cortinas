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
import { metadataDosCampos, modeloCadastro, ROTULO_DISPONIBILIDADE, STATUS_DISPONIBILIDADE, type CampoTecnico } from '@sistema/motor-calculo/navegador';

export type Categoria = {
  id: number; nome: string; paiId: number | null; caminho: string; perfil: string; nivel: number;
  markupPct?: string | null; markupEfetivo?: string; markupOrigem?: string; temSubcategorias: boolean; trilho: boolean;
};
type Produto = {
  id: string; sku: string; nome: string; corColecao: string | null; categoriaId: number; unidade: string;
  custoUnitario: string; precoVendaUnitario: string; metadata: Record<string, unknown>; fornecedorPadraoId: string | null;
  ativo: boolean | null; barras: { tamanhoM: number; custo: string; venda: string }[]; tabelaBarrasCompleta: boolean;
  disponibilidade: string; previsaoDisponivel: string | null;
};
type Historico = {
  id: string; tamanhoM: number | null; custoAnterior: string | null; custoNovo: string | null; vendaAnterior: string | null;
  vendaNova: string | null; motivo: string | null; alteradoEm: string; alteradoPor: string | null;
};
type Valores = Record<string, string | boolean>;

/** Valor da API ("42.5000") para o campo, sem zeros sobrando e sem perder casas: "42,50", "0,3525". */
function paraCampo(v: string | null | undefined): string {
  if (v == null) return '';
  const [inteiro, dec = ''] = v.split('.');
  return `${inteiro},${dec.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** Separa a metadata em: campos do tipo de produto (formulário) e o resto (avançado). */
function dividir(meta: Record<string, unknown>, perfil: string): { valores: Valores; extras: string } {
  const m = modeloCadastro(perfil);
  const valores: Valores = {};
  const resto: Record<string, unknown> = { ...meta };
  for (const c of m.campos) {
    const v = meta[c.chave];
    delete resto[c.chave];
    if (c.tipo === 'simnao') valores[c.chave] = v === true || v === 'true';
    else valores[c.chave] = v == null ? '' : c.tipo === 'opcoes' ? String(v) : String(v).replace('.', ',');
  }
  return { valores, extras: Object.keys(resto).length ? JSON.stringify(resto, null, 2) : '' };
}

/** Junta de volta os campos + o avançado. */
function juntar(perfil: string, valores: Valores, extras: string): { metadata: Record<string, unknown>; erros: string[] } {
  let base: Record<string, unknown> = {};
  if (extras.trim()) {
    try { base = JSON.parse(extras) as Record<string, unknown>; } catch { return { metadata: {}, erros: ['Dados técnicos avançados: texto inválido (formato JSON).'] }; }
  }
  return metadataDosCampos(perfil, valores, base);
}

/** Caminho de ids do topo até a categoria (ex.: [6, 24, 28] = Persianas › Rolo › Double Vision). */
function caminhoDe(cats: Categoria[], id: number): number[] {
  const r: number[] = [];
  for (let c = cats.find((x) => x.id === id); c && r.length < 10; c = c.paiId != null ? cats.find((x) => x.id === c!.paiId) : undefined) r.unshift(c.id);
  return r;
}

const ROTULO_NIVEL = ['Categoria *', 'Subcategoria *', 'Tipo *'];

export function EditorProduto({ id }: { id: string | null }) {
  const router = useRouter();
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [fornecedores, setFornecedores] = useState<{ id: string; nomeFantasia: string }[]>([]);
  const [produto, setProduto] = useState<Produto | null>(null);
  const [historico, setHistorico] = useState<Historico[]>([]);
  const [caminho, setCaminho] = useState<number[]>([]);
  const [unidade, setUnidade] = useState('');
  const [valores, setValores] = useState<Valores>({});
  const [extras, setExtras] = useState('');
  const [disponibilidade, setDisponibilidade] = useState('DISPONIVEL');
  const [previsao, setPrevisao] = useState('');
  const [custo, setCusto] = useState('');
  const [venda, setVenda] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    api<{ categorias: Categoria[] }>('/api/catalogo/categorias').then((r) => setCategorias(r.categorias));
    api<{ fornecedores: { id: string; nomeFantasia: string }[] }>('/api/fornecedores').then((r) => setFornecedores(r.fornecedores)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!id) return;
    api<{ produto: Produto; historico: Historico[] }>(`/api/catalogo/produtos/${id}`).then((r) => {
      setProduto(r.produto); setHistorico(r.historico ?? []);
      setCusto(paraCampo(r.produto.custoUnitario)); setVenda(paraCampo(r.produto.precoVendaUnitario)); setUnidade(r.produto.unidade);
      setDisponibilidade(r.produto.disponibilidade ?? 'DISPONIVEL'); setPrevisao(r.produto.previsaoDisponivel ?? '');
    }).catch((e) => setErro((e as Error).message));
  }, [id, versao]);
  // Com produto e categorias carregados: monta o caminho e separa os dados técnicos.
  useEffect(() => {
    if (!produto || categorias.length === 0) return;
    setCaminho(caminhoDe(categorias, produto.categoriaId));
    const perfilAtual = categorias.find((c) => c.id === produto.categoriaId)?.perfil ?? 'GENERICO';
    const d = dividir(produto.metadata ?? {}, perfilAtual);
    setValores(d.valores); setExtras(d.extras);
  }, [produto, categorias]);

  const ultima = categorias.find((c) => c.id === caminho[caminho.length - 1]);
  const final = ultima && !ultima.temSubcategorias ? ultima : undefined;
  const perfil = ultima?.perfil ?? 'GENERICO';
  const modelo = modeloCadastro(perfil);
  const markup = final?.markupEfetivo ?? ultima?.markupEfetivo;

  function escolherNivel(nivel: number, valor: string) {
    const novo = valor ? [...caminho.slice(0, nivel), Number(valor)] : caminho.slice(0, nivel);
    const perfilNovo = categorias.find((c) => c.id === novo[novo.length - 1])?.perfil ?? 'GENERICO';
    if (perfilNovo !== perfil) {
      // Troca de tipo: leva junto tudo o que já foi preenchido (nada se perde).
      const atual = juntar(perfil, valores, extras).metadata;
      const d = dividir(atual, perfilNovo);
      setValores(d.valores); setExtras(d.extras);
      if (!id) setUnidade(modeloCadastro(perfilNovo).unidadePadrao);
    }
    setCaminho(novo);
  }

  async function sugerir() {
    if (!custo) return;
    try {
      const r = await api<{ precoVendaSugerido: string }>(`/api/catalogo/preco-sugerido?custo=${encodeURIComponent(custo)}${final ? `&categoriaId=${final.id}` : ''}`);
      setVenda(paraCampo(r.precoVendaSugerido));
    } catch (e) { setErro((e as Error).message); }
  }

  async function salvar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null); setOk(null);
    if (!final) { setErro(ultima ? `Escolha a subcategoria de ${ultima.caminho}.` : 'Escolha a categoria.'); return; }
    const f = new FormData(e.currentTarget);
    const { metadata: metadataTecnica, erros } = juntar(perfil, valores, extras);
    if (erros.length) { setErro(erros.join(' ')); return; }
    const corpo = {
      sku: f.get('sku'), nome: f.get('nome'), corColecao: f.get('corColecao'), categoriaId: final.id,
      unidadeMedida: unidade || modelo.unidadePadrao, custoUnitario: custo, precoVendaUnitario: venda || null,
      fornecedorPadraoId: f.get('fornecedorPadraoId') || null, metadataTecnica, motivo: f.get('motivo') || null,
      disponibilidade, previsaoDisponivel: disponibilidade === 'EM_FALTA_COM_PREVISAO' ? previsao || null : null,
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
  const ehTrilho = final?.trilho ?? false;
  // Selects em cascata: Categoria → Subcategoria → Tipo (só aparece o nível que existe).
  const niveis: { nivel: number; opcoes: Categoria[] }[] = [{ nivel: 0, opcoes: categorias.filter((c) => c.paiId === null) }];
  caminho.forEach((cid, i) => {
    const filhas = categorias.filter((c) => c.paiId === cid);
    if (filhas.length) niveis.push({ nivel: i + 1, opcoes: filhas });
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/catalogo">← Catálogo</Link></Button>
        <h1 className="flex-1 text-xl font-semibold">{produto ? `${produto.sku} · ${produto.nome}` : 'Novo produto'}</h1>
        {produto && <Button variant="outline" size="sm" onClick={alternarAtivo}>{produto.ativo ? 'Inativar' : 'Reativar'}</Button>}
      </div>
      <Mensagens erro={erro} ok={ok} />
      {produto && ultima?.temSubcategorias && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          Este produto ainda não tem subcategoria. Escolha abaixo e salve.
        </p>
      )}

      <Card>
        <CardContent className="pt-5">
          <form key={produto?.id ?? 'novo'} onSubmit={salvar} className="grid gap-4 sm:grid-cols-2">
            {niveis.map(({ nivel, opcoes }) => (
              <div key={nivel} className="flex flex-col gap-1.5">
                <Label htmlFor={`categoria-${nivel}`}>{ROTULO_NIVEL[nivel] ?? 'Tipo *'}</Label>
                <select id={`categoria-${nivel}`} required value={caminho[nivel] ?? ''} onChange={(e) => escolherNivel(nivel, e.target.value)} className={classeSelect}>
                  <option value="" disabled>Escolha…</option>
                  {opcoes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                </select>
              </div>
            ))}
            {niveis.length % 2 === 1 && <div className="hidden sm:block" />}
            {ultima && modelo.descricao && <p className="text-sm text-muted-foreground sm:col-span-2">{modelo.descricao}</p>}

            <Campo rotulo="SKU *" nome="sku" required defaultValue={produto?.sku} className="uppercase" placeholder="TEC-010" />
            <Campo rotulo="Nome do produto *" nome="nome" required defaultValue={produto?.nome} placeholder={modelo.exemploNome ? `Ex.: ${modelo.exemploNome}` : undefined} />
            <Campo rotulo={modelo.rotuloCor} nome="corColecao" defaultValue={produto?.corColecao ?? ''} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="unidadeMedida">Unidade *</Label>
              <select id="unidadeMedida" required value={unidade || modelo.unidadePadrao} onChange={(e) => setUnidade(e.target.value)} className={classeSelect}>
                <option value="ML">ML (metro linear)</option><option value="M2">M² (metro quadrado)</option>
                <option value="UN">UN (unidade)</option><option value="PC">PC (peça)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fornecedorPadraoId">Fornecedor padrão</Label>
              <select id="fornecedorPadraoId" name="fornecedorPadraoId" defaultValue={produto?.fornecedorPadraoId ?? ''} className={classeSelect}>
                <option value="">—</option>
                {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nomeFantasia}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="disponibilidade">Status</Label>
              <select id="disponibilidade" value={disponibilidade} onChange={(e) => setDisponibilidade(e.target.value)} className={classeSelect}>
                {STATUS_DISPONIBILIDADE.map((s) => <option key={s} value={s}>{ROTULO_DISPONIBILIDADE[s]}</option>)}
              </select>
              <span className="text-xs text-muted-foreground">Só o vendedor vê. Fora de linha não pode ser enviado ao cliente; sob consulta só o administrador envia.</span>
            </div>
            {disponibilidade === 'EM_FALTA_COM_PREVISAO' ? (
              <Campo rotulo="Previsão de chegada *" nome="previsao" type="date" required value={previsao} onChange={(e) => setPrevisao(e.target.value)} />
            ) : <div className="hidden sm:block" />}
            <Campo rotulo="Custo unitário (R$) *" nome="custo" required inputMode="decimal" value={custo} onChange={(e) => setCusto(e.target.value)} placeholder="0,00" />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="venda">Venda unitária (R$)</Label>
              <div className="flex gap-2">
                <Input id="venda" inputMode="decimal" value={venda} onChange={(e) => setVenda(e.target.value)} placeholder={markup ? `em branco = custo + ${markup}%` : 'em branco = pelo markup'} />
                <Button type="button" variant="outline" onClick={sugerir} disabled={!custo}>Sugerir</Button>
              </div>
              {markup && (
                <span className="text-xs text-muted-foreground">
                  Markup {final?.markupOrigem && final.markupOrigem !== final.nome ? `(vem de ${final.markupOrigem}) ` : 'da categoria '}{markup}% · venda = custo × {(1 + Number(markup) / 100).toLocaleString('pt-BR')}
                </span>
              )}
            </div>
            <Campo rotulo="Motivo da mudança de preço" nome="motivo" largo placeholder="Ex.: reajuste do fornecedor (vai para o histórico)" />

            {modelo.campos.length > 0 && (
              <fieldset className="grid gap-4 rounded-md border p-3 sm:col-span-2 sm:grid-cols-2">
                <legend className="px-1 text-sm font-medium">Regras de medida e dados técnicos</legend>
                {modelo.campos.map((c) => (
                  <CampoTecnicoForm key={c.chave} campo={c} valor={valores[c.chave]} mudar={(v) => setValores((x) => ({ ...x, [c.chave]: v }))} />
                ))}
              </fieldset>
            )}
            <details className="sm:col-span-2" open={!ultima || (modelo.campos.length === 0 && extras !== '')}>
              <summary className="cursor-pointer text-sm text-muted-foreground">Dados técnicos avançados {extras ? '(tem dados)' : ''}</summary>
              <textarea aria-label="Dados técnicos avançados" value={extras} onChange={(e) => setExtras(e.target.value)} placeholder="{}" className={`${classeTextarea} mt-2 font-mono text-xs`} />
              <span className="text-xs text-muted-foreground">Outros dados usados pelo cálculo, no formato JSON. Normalmente fica vazio.</span>
            </details>
            <div className="sm:col-span-2"><Button type="submit">Salvar produto</Button></div>
          </form>
        </CardContent>
      </Card>

      {produto && ehTrilho && <TabelaBarras produto={produto} markup={markup ?? '100'} onSalvo={() => setVersao((v) => v + 1)} />}

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

/** Um campo técnico do tipo de produto (número, sim/não ou lista de opções). */
function CampoTecnicoForm({ campo: c, valor, mudar }: { campo: CampoTecnico; valor: string | boolean | undefined; mudar: (v: string | boolean) => void }) {
  const id = `meta-${c.chave}`;
  if (c.tipo === 'simnao') {
    return (
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input id={id} type="checkbox" className="mt-1" checked={valor === true} onChange={(e) => mudar(e.target.checked)} />
        <span>{c.rotulo}{c.dica && <span className="block text-xs text-muted-foreground">{c.dica}</span>}</span>
      </label>
    );
  }
  const rotulo = `${c.rotulo}${c.sufixo ? ` (${c.sufixo})` : ''}${c.obrigatorio ? ' *' : ''}`;
  if (c.tipo === 'opcoes') {
    const opcoes = c.opcoes ?? [];
    const comVazio = opcoes.some(([v]) => v === '') ? opcoes : [['', c.obrigatorio ? 'Escolha…' : '—'] as [string, string], ...opcoes];
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{rotulo}</Label>
        <select id={id} value={String(valor ?? '')} onChange={(e) => mudar(e.target.value)} className={classeSelect} required={c.obrigatorio}>
          {comVazio.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
        </select>
        {c.dica && <span className="text-xs text-muted-foreground">{c.dica}</span>}
      </div>
    );
  }
  return (
    <Campo rotulo={rotulo} nome={id} inputMode="decimal" value={String(valor ?? '')} onChange={(e) => mudar(e.target.value)} dica={c.dica} required={c.obrigatorio} />
  );
}
