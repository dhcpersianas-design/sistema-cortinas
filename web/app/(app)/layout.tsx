import { redirect } from 'next/navigation';
import { exigirUsuario } from '@/lib/sessao';
import { BarraTopo } from '@/components/barra-topo';

export default async function LayoutApp({ children }: { children: React.ReactNode }) {
  const u = await exigirUsuario();
  if (u.deveTrocarSenha) redirect('/trocar-senha');
  return (
    <div className="min-h-dvh">
      <BarraTopo nome={u.nome} perfil={u.perfil} />
      <main className="mx-auto max-w-6xl px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-8">{children}</main>
    </div>
  );
}
