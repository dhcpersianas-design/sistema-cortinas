import { apiServidor, exigirUsuario } from '@/lib/sessao';
import { Equipe, type Membro } from './equipe';

export default async function PaginaEquipe() {
  const eu = await exigirUsuario('usuarios.gerenciar');
  const { dados } = await apiServidor<{ usuarios: Membro[] }>('/api/usuarios');
  return <Equipe inicial={dados?.usuarios ?? []} meuId={eu.id} />;
}
