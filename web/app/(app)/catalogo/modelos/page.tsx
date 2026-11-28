import { exigirUsuario } from '@/lib/sessao';
import { ModelosCortina } from './modelos';

export default async function PaginaModelos() {
  await exigirUsuario('catalogo.editar');
  return <ModelosCortina />;
}
