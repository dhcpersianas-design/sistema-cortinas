import Link from 'next/link';
import { redirect } from 'next/navigation';
import { exigirUsuario } from '@/lib/sessao';
import { BotaoSair } from '@/components/botao-sair';
import { Badge } from '@/components/ui/badge';

export default async function LayoutApp({ children }: { children: React.ReactNode }) {
  const u = await exigirUsuario();
  if (u.deveTrocarSenha) redirect('/trocar-senha');
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Link href="/" className="whitespace-nowrap font-semibold">Cortinas</Link>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
            <Link href="/catalogo" className="rounded-md px-2 py-1 hover:bg-muted">Catálogo</Link>
            {u.permissoes.includes('usuarios.gerenciar') && (
              <Link href="/equipe" className="rounded-md px-2 py-1 hover:bg-muted">Equipe</Link>
            )}
          </nav>
          <span className="hidden text-sm sm:inline">{u.nome}</span>
          <Badge className="hidden sm:inline-flex">{u.perfil === 'ADMIN' ? 'Administrador' : 'Vendedor'}</Badge>
          <BotaoSair />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
