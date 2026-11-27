import { apiServidor, exigirUsuario } from '@/lib/sessao';
import { dinheiro } from '@/lib/utils';

type Produto = { id: string; sku: string; nome: string; categoria: string; unidade: string; custoUnitario?: string; precoVendaUnitario: string };

export default async function Catalogo() {
  const u = await exigirUsuario('catalogo.ver');
  const { dados } = await apiServidor<{ produtos: Produto[] }>('/api/catalogo/produtos');
  const produtos = dados?.produtos ?? [];
  const verCusto = u.permissoes.includes('custos.ver');
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Catálogo</h1>
      {produtos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum produto cadastrado ainda.</p>
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
              {produtos.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{p.sku}</td>
                  <td className="px-3 py-2">{p.nome}</td>
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
