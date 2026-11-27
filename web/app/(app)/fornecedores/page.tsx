import { exigirUsuario } from '@/lib/sessao';
import { Fornecedores } from './fornecedores';

export default async function PaginaFornecedores() {
  await exigirUsuario('fornecedores.ver');
  return <Fornecedores />;
}
