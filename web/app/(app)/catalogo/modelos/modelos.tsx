'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { avisar } from '@/components/aviso-flutuante';
import { api } from '@/lib/cliente';
import { dinheiro } from '@/lib/utils';
import { carregarCatalogo, modeloParaItem, type ModeloCortina, type ProdutoCatalogo } from '@/lib/orcamentos-offline';
import { calcularItem, REGRAS_ACESSORIO, type Catalogo, type EntradaItem } from '@sistema/motor-calculo/navegador';

/**
 * Modelos prontos de cortina (Gabriel, 28/11/2026). O administrador escolhe os produtos de cada
 * parte da cortina; o vendedor puxa o modelo no orçamento e o cálculo usa estes produtos.
 */

type Aplica = 'PRIMARIO' | 'SECUNDARIO' | 'CORTINA';
type Acessorio = { sku: string; aplica: Aplica; regra: string; quantidade?: string };
type Rascunho = {
  id?: string; nome: string; confeccao: 'WAVE' | 'PREGA' | 'FRANZIDO';
  tecidoSku: string; tecidoFator: string; secundarioSku: string; secundarioFator: string; trilhoSku: string;
  acessorios: Acessorio[]; maoObraSku: string; instalacaoSku: string; instalacaoAcima3Sku: string; ativo: boolean;
};

const VAZIO: Rascunho = {
  nome: '', confeccao: 'WAVE', tecidoSku: '', tecidoFator: '', secundarioSku: '', secundarioFator: '', trilhoSku: '',
  acessorios: [], maoObraSku: '', instalacaoSku: '', instalacaoAcima3Sku: '', ativo: true,
};
const CONFECCAO = { WAVE: 'Wave', PREGA: 'Prega macho', FRANZIDO: 'Franzido' } as const;
const PARTES: { aplica: Aplica; titulo: string; dica: string }[] = [
  { aplica: 'PRIMARIO', titulo: 'Acessórios do tecido primário', dica: 'Ex.: deslizante wave e entretela.' },
  { aplica: 'SECUNDARIO', titulo: 'Acessórios do tecido secundário', dica: 'Ex.: deslizante do forro.' },
  { aplica: 'CORTINA', titulo: 'Acessórios da cortina (por janela)', dica: 'Ex.: terminais (6 por cortina) e garras (a cada 40 cm).' },
];
const campo = (v: string | null | undefined) => (v == null ? '' : String(v).replace('.', ','));

/** Regra que mais combina com o produto escolhido (o administrador pode trocar). */
function regraSugerida(p: ProdutoCatalogo | undefined, aplica: Aplica): string {
  if (!p) return 'FIXA';
  const n = p.nome.toLowerCase();
  if (/entretela|fita/.test(n)) return aplica === 'PRIMARIO' ? 'ENTRETELA' : 'ML_TECIDO';
  if (/deslizante|carrinho|rodizio|rodízio/.test(n)) return 'DESLIZANTE';
  if (/terminal|final ?click|ponteira/.test(n)) return 'TERMINAL';
  if (/garra|suporte|presilha/.test(n)) return 'GARRA';
  if (p.perfil === 'TECIDO' || p.unidade === 'ML') return 'ML_TECIDO';
  return 'FIXA';
}

export function ModelosCortina() {
  const [modelos, setModelos] = useState<ModeloCortina[] | null>(null);
  const [produtos, setProdutos] = useState<ProdutoCatalogo[]>([]);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [editando, setEditando] = useState<Rascunho | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [excluir, setExcluir] = useState<string | null>(null);

  async function recarregar() {
    try { setModelos((await api<{ modelos: ModeloCortina[] }>('/api/catalogo/modelos-cortina?inativos=1')).modelos); }
    catch (e) { setErro((e as Error).message); }
  }
  useEffect(() => {
    recarregar();
    carregarCatalogo().then((c) => { setProdutos(c.produtos); setCatalogo(c.catalogo); }).catch((e) => setErro((e as Error).message));
  }, []);

  const nome = (sku: string | null | undefined) => (sku ? produtos.find((p) => p.sku === sku)?.nome ?? sku : '');

  function abrir(m?: ModeloCortina) {
    setErro(null);
    setEditando(m ? {
      id: m.id, nome: m.nome, confeccao: m.confeccao, tecidoSku: m.tecidoSku, tecidoFator: campo(m.tecidoFator),
      secundarioSku: m.secundarioSku ?? '', secundarioFator: campo(m.secundarioFator), trilhoSku: m.trilhoSku,
      acessorios: m.acessorios.map((a) => ({ ...a, quantidade: a.quantidade ? campo(a.quantidade) : undefined })),
      maoObraSku: m.maoObraSku ?? '', instalacaoSku: m.instalacaoSku ?? '', instalacaoAcima3Sku: m.instalacaoAcima3Sku ?? '', ativo: m.ativo,
    } : { ...VAZIO });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function salvar() {
    if (!editando) return;
    setErro(null);
    const r = editando;
    const corpo = {
      nome: r.nome, confeccao: r.confeccao, tecidoSku: r.tecidoSku, tecidoFator: r.tecidoFator || null,
      secundarioSku: r.secundarioSku || null, secundarioFator: r.secundarioSku ? r.secundarioFator || null : null,
      trilhoSku: r.trilhoSku,
      acessorios: r.acessorios.filter((a) => a.sku && (a.aplica !== 'SECUNDARIO' || r.secundarioSku))
        .map((a) => ({ sku: a.sku, aplica: a.aplica, regra: a.regra, ...(a.regra === 'FIXA' ? { quantidade: (a.quantidade || '1').replace(',', '.') } : {}) })),
      maoObraSku: r.maoObraSku || null, instalacaoSku: r.instalacaoSku || null, instalacaoAcima3Sku: r.instalacaoAcima3Sku || null, ativo: r.ativo,
    };
    try {
      if (!r.tecidoSku) throw new Error('Escolha o tecido primário.');
      if (!r.trilhoSku) throw new Error('Escolha o trilho.');
      if (r.id) await api(`/api/catalogo/modelos-cortina/${r.id}`, { method: 'PUT', corpo });
      else await api('/api/catalogo/modelos-cortina', { method: 'POST', corpo });
      avisar(r.id ? 'Modelo atualizado.' : 'Modelo salvo.');
      setEditando(null);
      await recarregar();
    } catch (e) { setErro((e as Error).message); }
  }

  async function apagar(id: string) {
    try {
      await api(`/api/catalogo/modelos-cortina/${id}`, { method: 'DELETE' });
      avisar('Modelo excluído.');
      setExcluir(null);
      await recarregar();
    } catch (e) { setErro((e as Error).message); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Modelos de cortina</h1>
          <p className="text-sm text-muted-foreground">Monte a cortina uma vez; no orçamento o vendedor só escolhe o modelo e digita as medidas.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline"><Link href="/catalogo">Catálogo</Link></Button>
          {!editando && <Button onClick={() => abrir()}>Novo modelo</Button>}
        </div>
      </div>
      <Mensagens erro={erro} />

      {editando && (
        <EditorModelo r={editando} mudar={setEditando} produtos={produtos} catalogo={catalogo} onSalvar={salvar} onCancelar={() => { setEditando(null); setErro(null); }} />
      )}

      {modelos === null ? <p className="text-sm text-muted-foreground">Carregando…</p> : modelos.length === 0 && !editando ? (
        <p className="rounded-lg border bg-card px-4 py-6 text-center text-sm text-muted-foreground">Nenhum modelo ainda. Toque em <strong>Novo modelo</strong> para montar o primeiro.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {modelos.map((m) => (
            <Card key={m.id} className={m.ativo ? '' : 'opacity-60'}>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {m.nome}
                  <Badge>{CONFECCAO[m.confeccao]}</Badge>
                  {!m.ativo && <Badge className="text-muted-foreground">inativo</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <p><span className="text-muted-foreground">Tecidos:</span> {nome(m.tecidoSku)}{m.secundarioSku ? ` + ${nome(m.secundarioSku)}` : ''}</p>
                <p><span className="text-muted-foreground">Trilho:</span> {nome(m.trilhoSku)}</p>
                <p><span className="text-muted-foreground">Acessórios:</span> {m.acessorios.length ? m.acessorios.map((a) => nome(a.sku)).join(', ') : 'nenhum'}</p>
                {m.maoObraSku && <p><span className="text-muted-foreground">Mão de obra:</span> {nome(m.maoObraSku)}</p>}
                {excluir === m.id ? (
                  <div role="alertdialog" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
                    <span className="flex-1">Excluir este modelo? Orçamentos já feitos com ele não mudam.</span>
                    <Button size="sm" variant="destructive" onClick={() => apagar(m.id)}>Excluir</Button>
                    <Button size="sm" variant="ghost" onClick={() => setExcluir(null)}>Cancelar</Button>
                  </div>
                ) : (
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={() => abrir(m)}>Editar</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setExcluir(m.id)}>Excluir</Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function EditorModelo({ r, mudar, produtos, catalogo, onSalvar, onCancelar }: {
  r: Rascunho; mudar: (r: Rascunho) => void; produtos: ProdutoCatalogo[]; catalogo: Catalogo | null; onSalvar: () => void; onCancelar: () => void;
}) {
  const set = (p: Partial<Rascunho>) => mudar({ ...r, ...p });
  const ativos = useMemo(() => produtos.filter((p) => p.disponibilidade !== 'FORA_DE_LINHA'), [produtos]);
  const grupo = useMemo(() => ({
    tecidos: ativos.filter((p) => p.perfil === 'TECIDO' || (!p.perfil && /^tecido/i.test(p.categoria))),
    trilhos: ativos.filter((p) => (p.perfil === 'TRILHO' || (!p.perfil && /^trilho/i.test(p.categoria))) && p.metadata?.trilho_motorizado !== true),
    maoObra: ativos.filter((p) => p.perfil === 'CONFECCAO' || /^m[aã]o de obra/i.test(p.categoria)),
    instalacao: ativos.filter((p) => p.perfil === 'INSTALACAO' || /instala/i.test(p.nome)),
    acessorios: ativos.filter((p) => p.perfil !== 'PERSIANA' && p.metadata?.trilho_motorizado !== true),
  }), [ativos]);

  // Prévia: o modelo calculado numa janela de 2,50 m x 2,60 m (2 folhas).
  const previa = useMemo(() => {
    if (!catalogo || !r.tecidoSku || !r.trilhoSku) return null;
    try {
      const m: ModeloCortina = {
        id: r.id ?? 'novo', nome: r.nome || 'Modelo', confeccao: r.confeccao, tecidoSku: r.tecidoSku, tecidoFator: r.tecidoFator.replace(',', '.') || null,
        secundarioSku: r.secundarioSku || null, secundarioFator: r.secundarioFator.replace(',', '.') || null, trilhoSku: r.trilhoSku,
        acessorios: r.acessorios.filter((a) => a.sku).map((a) => ({ ...a, quantidade: a.quantidade?.replace(',', '.') })) as ModeloCortina['acessorios'],
        maoObraSku: r.maoObraSku || null, instalacaoSku: r.instalacaoSku || null, instalacaoAcima3Sku: r.instalacaoAcima3Sku || null, ativo: true,
      };
      const entrada = {
        larguraTrilho: '2.50', alturaPronta: '2.60', numFolhas: 2, confeccao: m.confeccao,
        tecido: { sku: m.tecidoSku, ...(m.tecidoFator ? { fator: m.tecidoFator } : {}) },
        ...(m.secundarioSku ? { forro: { sku: m.secundarioSku, ...(m.secundarioFator ? { fator: m.secundarioFator } : {}) } } : {}),
        skus: { trilho: m.trilhoSku }, modelo: modeloParaItem(m),
      };
      const res = calcularItem({ tipo: 'CORTINA', entrada } as unknown as EntradaItem, [], catalogo);
      return { linhas: res.componentes.map((c) => ({ descricao: c.descricao, qtd: `${c.quantidade.toNumber().toLocaleString('pt-BR')} ${c.unidade}`, log: c.formulaLog })), total: res.vendaTotal.toFixed(2), alertas: res.alertas.map((a) => a.mensagem) };
    } catch (e) {
      // Ex.: tecido sem largura do rolo no cadastro: explica em português e aponta o produto.
      const msg = (e as Error).message.replace(/^SKU (\S+): metadata "largura_rolo" ausente$/, (_, sku: string) =>
        `${produtos.find((p) => p.sku === sku)?.nome ?? sku} (${sku}) está sem a largura do rolo no cadastro. Preencha no Catálogo para a cortina calcular.`);
      return { linhas: [], total: '0', alertas: [msg] };
    }
  }, [r, catalogo, produtos]);

  const opcoes = (lista: ProdutoCatalogo[]) => lista.map((p) => <option key={p.sku} value={p.sku}>{p.nome} ({p.sku})</option>);
  const porCategoria = (lista: ProdutoCatalogo[]) => {
    const g = new Map<string, ProdutoCatalogo[]>();
    for (const p of lista) g.set(p.categoria, [...(g.get(p.categoria) ?? []), p]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, ps]) => <optgroup key={c} label={c}>{opcoes(ps)}</optgroup>);
  };
  const sel = (id: string, rotulo: string, valor: string, onChange: (v: string) => void, lista: ProdutoCatalogo[], vazio: string, largo = false) => (
    <div className={`flex flex-col gap-1.5 ${largo ? 'sm:col-span-2' : ''}`}>
      <Label htmlFor={id}>{rotulo}</Label>
      <select id={id} value={valor} onChange={(e) => onChange(e.target.value)} className={classeSelect}>
        <option value="">{vazio}</option>
        {opcoes(lista)}
        {valor && !lista.some((p) => p.sku === valor) && <option value={valor}>{valor} (fora da lista)</option>}
      </select>
    </div>
  );

  function mudarAcessorio(i: number, p: Partial<Acessorio>) {
    set({ acessorios: r.acessorios.map((a, n) => (n === i ? { ...a, ...p } : a)) });
  }

  return (
    <Card>
      <CardHeader><CardTitle>{r.id ? 'Editar modelo' : 'Novo modelo'}</CardTitle></CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="m-nome">Nome do modelo</Label>
          <Input id="m-nome" value={r.nome} onChange={(e) => set({ nome: e.target.value })} placeholder="Cortina Wave Linho Voil + Corta Luz 70%" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="m-conf">Confecção do tecido primário</Label>
          <select id="m-conf" value={r.confeccao} onChange={(e) => set({ confeccao: e.target.value as Rascunho['confeccao'] })} className={classeSelect}>
            <option value="WAVE">Wave</option><option value="PREGA">Prega macho</option><option value="FRANZIDO">Franzido</option>
          </select>
          <span className="text-xs text-muted-foreground">O tecido secundário é sempre franzido.</span>
        </div>
        {sel('m-trilho', 'Trilho', r.trilhoSku, (v) => set({ trilhoSku: v }), grupo.trilhos, 'Escolha o trilho…')}

        {sel('m-tecido', 'Tecido primário', r.tecidoSku, (v) => set({ tecidoSku: v }), grupo.tecidos, 'Escolha o tecido…')}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="m-ftec">Fator do primário (opcional)</Label>
          <Input id="m-ftec" inputMode="decimal" value={r.tecidoFator} onChange={(e) => set({ tecidoFator: e.target.value })} />
          <span className="text-xs text-muted-foreground">Em branco: {{ WAVE: '2,8', PREGA: '3,0', FRANZIDO: '2,5' }[r.confeccao]} (padrão da loja).</span>
        </div>
        {sel('m-sec', 'Tecido secundário (opcional)', r.secundarioSku, (v) => set({ secundarioSku: v }), grupo.tecidos, 'Sem tecido secundário')}
        {r.secundarioSku ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m-fsec">Fator do secundário (opcional)</Label>
            <Input id="m-fsec" inputMode="decimal" value={r.secundarioFator} onChange={(e) => set({ secundarioFator: e.target.value })} />
            <span className="text-xs text-muted-foreground">Em branco: 1,8 (padrão da loja).</span>
          </div>
        ) : <div className="max-sm:hidden" />}

        {PARTES.filter((pt) => pt.aplica !== 'SECUNDARIO' || r.secundarioSku).map((pt) => (
          <fieldset key={pt.aplica} className="flex flex-col gap-2 rounded-md border p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-medium">{pt.titulo}</legend>
            <p className="text-xs text-muted-foreground">{pt.dica}</p>
            {r.acessorios.map((a, i) => a.aplica !== pt.aplica ? null : (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_18rem_5rem_auto] sm:items-end">
                <select aria-label="Produto" value={a.sku} className={classeSelect}
                  onChange={(e) => mudarAcessorio(i, { sku: e.target.value, regra: regraSugerida(produtos.find((p) => p.sku === e.target.value), pt.aplica) })}>
                  <option value="">Escolha o produto…</option>
                  {porCategoria(grupo.acessorios)}
                </select>
                <select aria-label="Como calcula" value={a.regra} onChange={(e) => mudarAcessorio(i, { regra: e.target.value })} className={classeSelect}>
                  {Object.entries(REGRAS_ACESSORIO)
                    .filter(([k]) => k !== 'ENTRETELA' || (pt.aplica === 'PRIMARIO' && r.confeccao === 'WAVE') || a.regra === k)
                    .filter(([k]) => k !== 'ML_TECIDO' || pt.aplica !== 'CORTINA' || a.regra === k)
                    .map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                </select>
                {a.regra === 'FIXA'
                  ? <Input aria-label="Quantidade" inputMode="decimal" value={a.quantidade ?? '1'} onChange={(e) => mudarAcessorio(i, { quantidade: e.target.value })} />
                  : <span className="max-sm:hidden" />}
                <Button type="button" variant="ghost" size="sm" onClick={() => set({ acessorios: r.acessorios.filter((_, n) => n !== i) })}>Tirar</Button>
              </div>
            ))}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => set({ acessorios: [...r.acessorios, { sku: '', aplica: pt.aplica, regra: 'FIXA' }] })}>+ Acessório</Button>
            </div>
          </fieldset>
        ))}

        {sel('m-mdo', 'Mão de obra da confecção (cortina inteira)', r.maoObraSku, (v) => set({ maoObraSku: v }), grupo.maoObra, 'Sem mão de obra', true)}
        <p className="-mt-2 text-xs text-muted-foreground sm:col-span-2">
          Cobra o valor do serviço x a largura do trilho e cobre a cortina toda ({r.secundarioSku ? 'primário + secundário' : 'só 1 tecido'}).
          Cortina de 1 tecido usa outro modelo, com o serviço de 1 tecido.
        </p>
        {sel('m-inst', 'Instalação até 3 m (opcional)', r.instalacaoSku, (v) => set({ instalacaoSku: v }), grupo.instalacao, 'Padrão (SRV-001)')}
        {sel('m-inst3', 'Instalação acima de 3 m (opcional)', r.instalacaoAcima3Sku, (v) => set({ instalacaoAcima3Sku: v }), grupo.instalacao, 'Padrão (SRV-004)')}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={r.ativo} onChange={(e) => set({ ativo: e.target.checked })} /> Ativo (aparece para o vendedor no orçamento)
        </label>

        {previa && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm sm:col-span-2">
            <p className="mb-2 font-medium">Exemplo: janela de 2,50 m x 2,60 m, 2 folhas</p>
            <ul className="space-y-1">
              {previa.linhas.map((l, n) => (
                <li key={n} className="flex flex-wrap justify-between gap-x-3">
                  <span>{l.descricao}</span><span className="tabular-nums text-muted-foreground">{l.qtd}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t pt-2 text-right font-medium">Venda: {dinheiro(previa.total)}</p>
            {previa.alertas.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-300">{previa.alertas.map((a, n) => <li key={n}>{a}</li>)}</ul>
            )}
          </div>
        )}

        <div className="flex gap-2 sm:col-span-2">
          <Button type="button" onClick={onSalvar}>Salvar modelo</Button>
          <Button type="button" variant="ghost" onClick={onCancelar}>Cancelar</Button>
        </div>
      </CardContent>
    </Card>
  );
}
