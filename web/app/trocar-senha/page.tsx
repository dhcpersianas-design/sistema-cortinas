import { exigirUsuario } from '@/lib/sessao';
import { TelaMarca } from '@/components/tela-marca';
import { FormTrocarSenha } from './form';

export default async function TrocarSenha() {
  const u = await exigirUsuario();
  return (
    <TelaMarca
      titulo="Criar nova senha"
      subtitulo={u.deveTrocarSenha ? 'Antes de começar, troque a senha provisória.' : 'Troque sua senha de acesso.'}
    >
      <FormTrocarSenha />
    </TelaMarca>
  );
}
