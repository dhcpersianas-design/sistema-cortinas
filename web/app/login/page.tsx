import { redirect } from 'next/navigation';
import { usuarioAtual } from '@/lib/sessao';
import { TelaMarca } from '@/components/tela-marca';
import { FormLogin } from './form-login';

export default async function PaginaLogin() {
  if (await usuarioAtual()) redirect('/');
  return (
    <TelaMarca titulo="Entrar" subtitulo="Orçamentos, pedidos e gestão da loja">
      <FormLogin />
    </TelaMarca>
  );
}
