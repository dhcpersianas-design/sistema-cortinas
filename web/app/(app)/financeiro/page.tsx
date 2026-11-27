import { exigirUsuario } from '@/lib/sessao';
import { Financeiro } from './financeiro';

export default async function PaginaFinanceiro() {
  await exigirUsuario('financeiro.gerenciar');
  return <Financeiro />;
}
