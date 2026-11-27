import { exigirUsuario } from '@/lib/sessao';
import { FormTrocarSenha } from './form';

export default async function TrocarSenha() {
  const u = await exigirUsuario();
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold">Criar nova senha</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {u.deveTrocarSenha ? 'Antes de começar, troque a senha provisória.' : 'Troque sua senha de acesso.'}
        </p>
        <FormTrocarSenha />
      </div>
    </main>
  );
}
