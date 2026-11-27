import { exigirUsuario } from '@/lib/sessao';
import { ImportarPrecos } from './importar';

export default async function PaginaImportarPrecos() {
  await exigirUsuario('catalogo.editar');
  return <ImportarPrecos />;
}
