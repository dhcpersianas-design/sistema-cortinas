'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { dinheiro } from '@/lib/utils';
import type { Categoria } from '../[id]/editor';
import { ConfirmarAlteracao } from '@/components/confirmar-alteracao';

type PreviaMarkup = {
  caminho: string; markupAntes: string; markupDepois: string; afetados: number; produtosNaCategoria: number;
  linhas: { sku: string; nome: string; tamanhoM: number | null; ativo: boolean; vendaAntes: string; vendaDepois: string }[];
};
type Pendente = { c: Categoria; nome: string; markup: string; previa: PreviaMarkup };

const pct = (v: string | null | undefined) => (v == null ? '' : String(Number(v)).replace('.', ','));

/**
 * Categorias do catálogo e markup de cada uma (Gabriel, 27/11/2026).
 * Markup = quanto a venda fica acima do custo. Só muda em subcategoria (não em "Persianas" inteira).
 * Mudar o markup RECALCULA a venda de todos os produtos da subcategoria, depois de uma prévia
 * e da palavra ALTERAR digitada na caixinha de segurança.
 */
export function CategoriasMarkup() {
  const [cats, setCats] = useState<Categoria[] | null>(null);
  const [msg, setMsg] = useState<{ erro?: string; ok?: string; avisos?: string[] }>({});
  const [pendente, setPendente] = useState<Pendente | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(() => {
    api<{ categorias: Categoria[] }>('/api/catalogo/categorias').then((r) => setCats(r.categorias)).catch((e) => setMsg({ erro: (e as Error).message }));
  }, []);
  useEffect(carregar, [carregar]);

  const mudouMarkup = (c: Categoria, markup: string) => markup !== pct(c.markupPct);

  /** Só nome: salva direto. Markup: mostra a prévia e pede ALTERAR. */
  async function salvar(c: Categoria, nome: string, markup: string) {
    setMsg({});
    const markupPct = markup.trim() === '' ? null : markup;
    try {
      if (!c.temSubcategorias && mudouMarkup(c, markup)) {
        const previa = await api<PreviaMarkup>(`/api/catalogo/categorias/${c.id}/markup/previa`, { method: 'POST', corpo: { markupPct } });
        setPendente({ c, nome, markup, previa });
        return;
      }
      await api(`/api/catalogo/categorias/${c.id}`, { method: 'PATCH', corpo: { nome } });
      setMsg({ ok: `${nome}: salvo.` });
      carregar();
    } catch (e) { setMsg({ erro: (e as Error).message }); }
  }

  async function confirmarMarkup(palavra: string) {
    if (!pendente) return;
    const { c, nome, markup } = pendente;
    setOcupado(true);
    try {
      const r = await api<{ alterados: number }>(`/api/catalogo/categorias/${c.id}`, {
        method: 'PATCH', corpo: { ...(c.paiId !== null ? { nome } : {}), markupPct: markup.trim() === '' ? null : markup, confirmacao: palavra },
      });
      setMsg({ ok: `${c.caminho}: markup salvo. ${r.alterados} preço(s) de venda recalculado(s).` });
      setPendente(null);
      carregar();
    } catch (e) { setMsg({ erro: (e as Error).message }); setPendente(null); } finally { setOcupado(false); }
  }

  async function criar(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setMsg({});
    const form = ev.currentTarget;
    const f = new FormData(form);
    try {
      const r = await api<{ avisos: string[] }>('/api/catalogo/categorias', { method: 'POST', corpo: { nome: f.get('nome'), paiId: Number(f.get('paiId')) } });
      setMsg({ ok: 'Subcategoria criada.', avisos: r.avisos });
      form.reset();
      carregar();
    } catch (e) { setMsg({ erro: (e as Error).message }); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/catalogo">← Catálogo</Link></Button>
        <h1 className="flex-1 text-xl font-semibold">Categorias e markup</h1>
      </div>
      <Mensagens erro={msg.erro} ok={msg.ok} avisos={msg.avisos} />

      <Card>
        <CardHeader>
          <CardTitle>Markup por categoria</CardTitle>
          <CardDescription>
            Markup é quanto a venda fica acima do custo (100% = venda é o dobro do custo). Ele só muda na
            subcategoria (ex.: Horizontal), nunca na categoria principal inteira. Ao salvar, o sistema mostra quantos
            produtos mudam e pede para digitar ALTERAR; aí <strong>a venda de todos os produtos da subcategoria é
            recalculada</strong> (custo × markup). Subcategoria em branco usa a base da categoria de cima.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cats === null ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
            <div className="flex flex-col divide-y">
              {cats.map((c) => <LinhaCategoria key={`${c.id}-${c.markupPct}-${c.nome}`} c={c} pai={cats.find((x) => x.id === c.paiId)} salvar={salvar} />)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nova subcategoria</CardTitle>
          <CardDescription>Ela pede os mesmos dados técnicos da categoria de cima (ex.: uma nova subcategoria de Persianas pede as medidas mínimas e máximas).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={criar} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="paiId">Dentro de</Label>
              <select id="paiId" name="paiId" required defaultValue="" className={classeSelect}>
                <option value="" disabled>Escolha…</option>
                {(cats ?? []).filter((c) => c.nivel < 2).map((c) => <option key={c.id} value={c.id}>{c.caminho}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nome">Nome</Label>
              <Input id="nome" name="nome" required minLength={2} maxLength={80} placeholder="Ex.: Suportes" />
            </div>
            <Button type="submit">Criar</Button>
          </form>
        </CardContent>
      </Card>
      {pendente && (
        <ConfirmarAlteracao titulo={`Mudar o markup de ${pendente.previa.caminho}?`} ocupado={ocupado}
          aoCancelar={() => setPendente(null)} aoContinuar={confirmarMarkup}>
          <p className="text-sm">
            Markup {Number(pendente.previa.markupAntes)}% → <strong>{Number(pendente.previa.markupDepois)}%</strong>.{' '}
            {pendente.previa.afetados === 0
              ? `Nenhum preço muda (${pendente.previa.produtosNaCategoria} produto(s) nesta subcategoria).`
              : <><strong>{pendente.previa.afetados} preço(s) de venda</strong> serão recalculados:</>}
          </p>
          {pendente.previa.linhas.length > 0 && (
            <div className="max-h-60 overflow-y-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted text-left"><tr><th className="px-2 py-1">Produto</th><th className="px-2 py-1 text-right">Venda hoje</th><th className="px-2 py-1 text-right">Nova venda</th></tr></thead>
                <tbody>
                  {pendente.previa.linhas.map((l) => (
                    <tr key={`${l.sku}-${l.tamanhoM}`} className={`border-t ${l.ativo ? '' : 'opacity-60'}`}>
                      <td className="px-2 py-1">{l.sku} · {l.nome}{l.tamanhoM ? ` (barra ${l.tamanhoM} m)` : ''}{l.ativo ? '' : ' (inativo)'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{dinheiro(l.vendaAntes)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{dinheiro(l.vendaDepois)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ConfirmarAlteracao>
      )}
    </div>
  );
}

function LinhaCategoria({ c, pai, salvar }: { c: Categoria; pai?: Categoria; salvar: (c: Categoria, nome: string, markup: string) => void }) {
  const [nome, setNome] = useState(c.nome);
  const [markup, setMarkup] = useState(pct(c.markupPct));
  const editaMarkup = !c.temSubcategorias;
  const efetivo = markup.trim() === '' ? Number(pai?.markupEfetivo ?? c.markupEfetivo ?? 100) : Number(markup.replace(',', '.'));
  const mudou = nome !== c.nome || (editaMarkup && markup !== pct(c.markupPct));
  const principal = c.paiId === null;
  return (
    <div className={`grid items-center gap-2 py-2 sm:grid-cols-[1fr_8rem_9rem_auto] ${principal ? 'pt-4' : ''}`} style={{ paddingLeft: `${c.nivel * 1.25}rem` }}>
      {principal
        ? <span className="font-semibold">{c.nome}</span>
        : <Input aria-label={`Nome de ${c.caminho}`} value={nome} onChange={(e) => setNome(e.target.value)} className="h-9" />}
      {editaMarkup ? (
        <div className="flex items-center gap-1">
          <Input aria-label={`Markup de ${c.caminho}`} inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)}
            placeholder={principal ? '100' : `herda ${pct(pai?.markupEfetivo ?? '')}`} className="h-9 text-right" />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{principal ? `base ${pct(c.markupEfetivo)}% · ` : ''}mude nas subcategorias</span>
      )}
      <span className="text-xs text-muted-foreground">
        {editaMarkup && (Number.isFinite(efetivo) ? `custo ${dinheiro('100')} → ${dinheiro(String(100 * (1 + efetivo / 100)))}` : 'markup inválido')}
      </span>
      {principal && !editaMarkup ? <span /> : (
        <Button size="sm" variant={mudou ? 'default' : 'outline'} disabled={!mudou} onClick={() => salvar(c, nome, markup)}>Salvar</Button>
      )}
    </div>
  );
}
