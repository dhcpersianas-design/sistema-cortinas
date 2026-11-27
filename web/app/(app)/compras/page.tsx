import { exigirUsuario } from '@/lib/sessao';
import { Compras } from './compras';

export default async function PaginaCompras() {
  await exigirUsuario('compras.gerenciar');
  return <Compras />;
}
