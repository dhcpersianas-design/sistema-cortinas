import { exigirUsuario } from '@/lib/sessao';
import { Relatorios } from './relatorios';

export default async function PaginaRelatorios() {
  await exigirUsuario('relatorios.ver');
  return <Relatorios />;
}
