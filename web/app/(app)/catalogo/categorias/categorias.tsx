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

const pct = (v: string | null | undefined) => (v == null ? '' : String(Number(v)).replace('.', ','));

/**
 * Categorias do catálogo e markup de cada uma (Gabriel, 27/11/2026).
 * Markup = quanto a venda sugerida fica acima do custo. Subcategoria em branco usa o da categoria de cima.
 * Mudar o markup não muda o preço de produto já cadastrado: vale para a venda sugerida
 * (cadastro, "Sugerir", tabela de barras e importação com Venda vazia).
 */
export function CategoriasMarkup() {
  const [cats, setCats] = useState<Categoria[] | null>(null);
  const [msg, setMsg] = useState<{ erro?: string; ok?: string; avisos?: string[] }>({});

  const carregar = useCallback(() => {
    api<{ categorias: Categoria[] }>('/api/catalogo/categorias').then((r) => setCats(r.categorias)).catch((e) => setMsg({ erro: (e as Error).message }));
  }, []);
  useEffect(carregar, [carregar]);

  async function salvar(c: Categoria, nome: string, markup: string) {
    setMsg({});
    try {
      await api(`/api/catalogo/categorias/${c.id}`, { method: 'PATCH', corpo: { ...(c.paiId !== null ? { nome } : {}), markupPct: markup.trim() === '' ? null : markup } });
      setMsg({ ok: `${c.paiId === null ? c.nome : nome}: salvo.` });
      carregar();
    } catch (e) { setMsg({ erro: (e as Error).message }); }
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
            Markup é quanto a venda sugerida fica acima do custo (100% = venda é o dobro do custo).
            Subcategoria em branco usa o markup da categoria de cima. Mudar aqui não altera preços já cadastrados:
            vale para a venda sugerida no cadastro, na tabela de barras e na importação com a coluna Venda vazia.
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
    </div>
  );
}

function LinhaCategoria({ c, pai, salvar }: { c: Categoria; pai?: Categoria; salvar: (c: Categoria, nome: string, markup: string) => void }) {
  const [nome, setNome] = useState(c.nome);
  const [markup, setMarkup] = useState(pct(c.markupPct));
  const efetivo = markup.trim() === '' ? Number(pai?.markupEfetivo ?? c.markupEfetivo ?? 100) : Number(markup.replace(',', '.'));
  const mudou = nome !== c.nome || markup !== pct(c.markupPct);
  const principal = c.paiId === null;
  return (
    <div className={`grid items-center gap-2 py-2 sm:grid-cols-[1fr_8rem_11rem_auto] ${principal ? 'pt-4' : ''}`} style={{ paddingLeft: `${c.nivel * 1.25}rem` }}>
      {principal
        ? <span className="font-semibold">{c.nome}</span>
        : <Input aria-label={`Nome de ${c.caminho}`} value={nome} onChange={(e) => setNome(e.target.value)} className="h-9" />}
      <div className="flex items-center gap-1">
        <Input aria-label={`Markup de ${c.caminho}`} inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)}
          placeholder={principal ? '100' : `herda ${pct(pai?.markupEfetivo ?? '')}`} className="h-9 text-right" required={principal} />
        <span className="text-sm text-muted-foreground">%</span>
      </div>
      <span className="text-xs text-muted-foreground">
        {Number.isFinite(efetivo) ? `custo ${dinheiro('100')} → ${dinheiro(String(100 * (1 + efetivo / 100)))}` : 'markup inválido'}
      </span>
      <Button size="sm" variant={mudou ? 'default' : 'outline'} disabled={!mudou} onClick={() => salvar(c, nome, markup)}>Salvar</Button>
    </div>
  );
}
