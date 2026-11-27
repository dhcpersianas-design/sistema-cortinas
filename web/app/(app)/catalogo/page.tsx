import { exigirUsuario } from '@/lib/sessao';
import { ListaCatalogo } from './lista';

export default async function Catalogo() {
  const u = await exigirUsuario('catalogo.ver');
  return <ListaCatalogo verCusto={u.permissoes.includes('custos.ver')} editar={u.permissoes.includes('catalogo.editar')} />;
}
