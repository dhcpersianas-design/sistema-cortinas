import { Suspense } from 'react';
import { exigirUsuario } from '@/lib/sessao';
import { Pedidos } from './pedidos';

export default async function PaginaPedidos() {
  const u = await exigirUsuario('pedidos.proprios');
  return (
    <Suspense>
      <Pedidos admin={u.permissoes.includes('compras.gerenciar')} />
    </Suspense>
  );
}
