import { exigirUsuario } from '@/lib/sessao';
import { PosVenda } from './pos-venda';

export default async function PaginaPosVenda() {
  await exigirUsuario('pedidos.proprios');
  return <PosVenda />;
}
