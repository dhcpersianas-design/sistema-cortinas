import { exigirUsuario } from '@/lib/sessao';
import { CategoriasMarkup } from './categorias';

export default async function PaginaCategorias() {
  await exigirUsuario('precos.editar');
  return <CategoriasMarkup />;
}
