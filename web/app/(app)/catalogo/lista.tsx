'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { classeSelect, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { dinheiro } from '@/lib/utils';
import { semAcento } from '@/lib/texto';

export type ProdutoLista = {
  id: string; sku: string; nome: string; corColecao: string | null; categoriaId: number; categoria: string; unidade: string;
  custoUnitario?: string; precoVendaUnitario: string; ativo: boolean | null; fornecedorNome?: string | null;
  tabelaBarrasCompleta: boolean; barras: { tamanhoM: number; custo?: string; venda: string }[];
};

/**
 * Lista do catálogo. Baixa tudo de uma vez e filtra no aparelho: a mesma
 * resposta fica no cache do service worker e a tela abre offline na obra.
 */
export function ListaCatalogo({ verCusto, editar }: { verCusto: boolean; editar: boolean }) {
  const [produtos, setProdutos] = useState<ProdutoLista[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [categoria, setCategoria] = useState('');
  const [inativos, setInativos] = useState(false);

  useEffect(() => {
    api<{ produtos: ProdutoLista[] }>(`/api/catalogo/produtos${editar ? '?inativos=1' : ''}`)
      .then((r) => setProdutos(r.produtos)).catch((e) => setErro((e as Error).message));
  }, [editar]);

  const categorias = useMemo(() => [...new Map((produtos ?? []).map((p) => [p.categoriaId, p.categoria])).entries()], [produtos]);
  const filtrados = useMemo(() => {
    const t = semAcento(q.trim());
    return (produtos ?? []).filter((p) => (inativos || p.ativo !== false)
      && (!categoria || String(p.categoriaId) === categoria)
      && (!t || semAcento(`${p.sku} ${p.nome} ${p.corColecao ?? ''}`).includes(t)));
  }, [produtos, q, categoria, inativos]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Catálogo</h1>
        {editar && <Button asChild><Link href="/catalogo/novo">Novo produto</Link></Button>}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_14rem_auto]">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por SKU, nome ou cor" aria-label="Buscar produtos" />
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className={classeSelect} aria-label="Categoria">
          <option value="">Todas as categorias</option>
          {categorias.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
        </select>
        {editar && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inativos} onChange={(e) => setInativos(e.target.checked)} /> inativos</label>}
      </div>
      <Mensagens erro={erro} />
      {produtos === null ? <p className="text-sm text-muted-foreground">Carregando…</p> : filtrados.length === 0 ? (
        <p className="text-sm text-muted-foreground">{produtos.length ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado ainda.'}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left">
              <tr>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Produto</th>
                <th className="hidden px-3 py-2 sm:table-cell">Categoria</th>
                <th className="px-3 py-2">Un.</th>
                {verCusto && <th className="px-3 py-2 text-right">Custo</th>}
                <th className="px-3 py-2 text-right">Venda</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map((p) => (
                <tr key={p.id} className={`border-t ${p.ativo === false ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2 font-mono text-xs">{editar ? <Link className="underline" href={`/catalogo/${p.id}`}>{p.sku}</Link> : p.sku}</td>
                  <td className="px-3 py-2">
                    {p.nome}{p.corColecao ? ` · ${p.corColecao}` : ''}
                    {p.barras.length > 0 && (
                      <Badge className={`ml-2 ${p.tabelaBarrasCompleta ? '' : 'border-amber-500/50'}`}>
                        {p.tabelaBarrasCompleta ? 'preço por barra' : `barras ${p.barras.length}/6`}
                      </Badge>
                    )}
                  </td>
                  <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">{p.categoria}</td>
                  <td className="px-3 py-2">{p.unidade}</td>
                  {verCusto && <td className="px-3 py-2 text-right tabular-nums">{dinheiro(p.custoUnitario)}</td>}
                  <td className="px-3 py-2 text-right tabular-nums">{dinheiro(p.precoVendaUnitario)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
