import { redirect } from 'next/navigation';
import { usuarioAtual } from '@/lib/sessao';
import { FormLogin } from './form-login';

export default async function PaginaLogin() {
  if (await usuarioAtual()) redirect('/');
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold">Entrar</h1>
        <p className="mb-6 text-sm text-muted-foreground">Sistema de cortinas e persianas</p>
        <FormLogin />
      </div>
    </main>
  );
}
