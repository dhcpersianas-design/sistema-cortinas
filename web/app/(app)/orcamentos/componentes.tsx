'use client';
import { useState } from 'react';
import type { Ajuste } from '@sistema/motor-calculo/navegador';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { classeSelect } from '@/components/cadastro/campos';
import type { Item, ProdutoCatalogo } from '@/lib/orcamentos-offline';
import { moeda, qtd } from './formato';

/**
 * Explosão (BOM) do item, editável (regra de ouro 3): trocar, incluir, remover ou mudar a
 * quantidade de qualquer componente. Cada mudança vira um ajuste com motivo, auditado no servidor.
 */
type Props = {
  item: Item; produtos: ProdutoCatalogo[]; editavel: boolean; verCusto: boolean;
  onAjustes: (ajustes: Ajuste[]) => void;
};

type Edicao = { tipo: 'QUANTIDADE' | 'SUBSTITUIR' | 'REMOVER'; sku: string } | { tipo: 'ADICIONAR' } | null;

export function TabelaComponentes({ item, produtos, editavel, verCusto, onAjustes }: Props) {
  const [edicao, setEdicao] = useState<Edicao>(null);
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const comps = item.componentes ?? [];

  function aplicar() {
    if (!edicao) return;
    const m = motivo.trim() || undefined;
    let a: Ajuste;
    if (edicao.tipo === 'QUANTIDADE') a = { tipo: 'QUANTIDADE', sku: edicao.sku, quantidade: valor.replace(',', '.'), motivo: m };
    else if (edicao.tipo === 'REMOVER') a = { tipo: 'REMOVER', sku: edicao.sku, motivo: m };
    else if (edicao.tipo === 'SUBSTITUIR') a = { tipo: 'SUBSTITUIR', sku: edicao.sku, novoSku: valor, motivo: m };
    else return;
    // Ajuste repetido sobre o mesmo componente substitui o anterior (fica só o último).
    const outros = item.ajustes.filter((x) => !(a.tipo === 'QUANTIDADE' && x.tipo === 'QUANTIDADE' && x.sku === a.sku));
    onAjustes([...outros, a]);
    setEdicao(null); setValor(''); setMotivo('');
  }

  const unidadeDe = (sku: string) => comps.find((c) => c.sku === sku)?.unidade;
  const [skuAdd, setSkuAdd] = useState('');
  const [qtdAdd, setQtdAdd] = useState('1');

  function incluir() {
    onAjustes([...item.ajustes, { tipo: 'ADICIONAR', sku: skuAdd, quantidade: qtdAdd.replace(',', '.'), motivo: motivo.trim() || undefined }]);
    setEdicao(null); setSkuAdd(''); setQtdAdd('1'); setMotivo('');
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">SKU</th><th className="py-1 pr-2">Componente</th><th className="py-1 pr-2 text-right">Qtd</th>
              <th className="py-1 pr-2 text-right">Venda</th>
              {verCusto && <th className="py-1 pr-2 text-right">Custo</th>}
              {editavel && <th />}
            </tr>
          </thead>
          <tbody>
            {comps.map((c) => (
              <tr key={c.sku} className="border-t align-top">
                <td className="py-1 pr-2 font-mono">{c.sku}</td>
                <td className="py-1 pr-2">
                  {c.descricao}
                  {c.origem === 'MANUAL' && <span className="ml-1 text-amber-700 dark:text-amber-400">(manual)</span>}
                  {c.formulaLog && <div className="text-[11px] text-muted-foreground">{c.formulaLog}</div>}
                </td>
                <td className="whitespace-nowrap py-1 pr-2 text-right">
                  {qtd(c.quantidade, c.unidade)} {c.unidade}
                  {c.quantidadeOverride && c.quantidadeCalculada && <div className="text-[11px] text-muted-foreground">motor: {qtd(c.quantidadeCalculada, c.unidade)}</div>}
                </td>
                <td className="whitespace-nowrap py-1 pr-2 text-right">{moeda(c.precoTotal)}</td>
                {verCusto && <td className="whitespace-nowrap py-1 pr-2 text-right text-muted-foreground">{c.custoTotal ? moeda(c.custoTotal) : ''}</td>}
                {editavel && (
                  <td className="whitespace-nowrap py-1 text-right">
                    <button type="button" className="px-1 underline" onClick={() => { setEdicao({ tipo: 'QUANTIDADE', sku: c.sku }); setValor(qtd(c.quantidade, c.unidade)); }}>qtd</button>
                    <button type="button" className="px-1 underline" onClick={() => { setEdicao({ tipo: 'SUBSTITUIR', sku: c.sku }); setValor(''); }}>trocar</button>
                    <button type="button" className="px-1 text-destructive underline" onClick={() => setEdicao({ tipo: 'REMOVER', sku: c.sku })}>remover</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editavel && edicao && edicao.tipo !== 'ADICIONAR' && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border p-2 text-sm">
          <span className="font-medium">
            {edicao.tipo === 'QUANTIDADE' ? `Quantidade de ${edicao.sku}` : edicao.tipo === 'SUBSTITUIR' ? `Trocar ${edicao.sku} por` : `Remover ${edicao.sku}?`}
          </span>
          {edicao.tipo === 'QUANTIDADE' && <Input className="w-24" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />}
          {edicao.tipo === 'SUBSTITUIR' && (
            <select className={`${classeSelect} w-64`} value={valor} onChange={(e) => setValor(e.target.value)}>
              <option value="">Escolha…</option>
              {produtos.filter((p) => p.unidade === unidadeDe(edicao.sku) && p.sku !== edicao.sku && !comps.some((c) => c.sku === p.sku))
                .map((p) => <option key={p.sku} value={p.sku}>{p.nome} ({p.sku})</option>)}
            </select>
          )}
          <Input className="w-56" placeholder="Motivo (opcional)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          <Button size="sm" type="button" onClick={aplicar} disabled={edicao.tipo !== 'REMOVER' && !valor}>Aplicar</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setEdicao(null)}>Cancelar</Button>
        </div>
      )}

      {editavel && (
        edicao?.tipo === 'ADICIONAR' ? (
          <div className="flex flex-wrap items-end gap-2 rounded-md border p-2 text-sm">
            <select className={`${classeSelect} w-64`} value={skuAdd} onChange={(e) => setSkuAdd(e.target.value)}>
              <option value="">Componente…</option>
              {produtos.filter((p) => !comps.some((c) => c.sku === p.sku)).map((p) => <option key={p.sku} value={p.sku}>{p.nome} ({p.sku}, {p.unidade})</option>)}
            </select>
            <Input className="w-20" inputMode="decimal" value={qtdAdd} onChange={(e) => setQtdAdd(e.target.value)} />
            <Input className="w-56" placeholder="Motivo (opcional)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            <Button size="sm" type="button" disabled={!skuAdd} onClick={incluir}>Incluir</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEdicao(null)}>Cancelar</Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="button" variant="outline" onClick={() => setEdicao({ tipo: 'ADICIONAR' })}>Incluir componente</Button>
            {item.ajustes.length > 0 && (
              <Button size="sm" type="button" variant="ghost" onClick={() => onAjustes(item.ajustes.slice(0, -1))}>Desfazer último ajuste</Button>
            )}
          </div>
        )
      )}
    </div>
  );
}
