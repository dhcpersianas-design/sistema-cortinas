'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, House, LogOut } from 'lucide-react';
import { Logo } from '@/components/logo';
import { SeletorTema } from '@/components/tema';
import { api } from '@/lib/cliente';
import { cn } from '@/lib/utils';

type Props = { nome: string; perfil: 'ADMIN' | 'VENDEDOR' };

/**
 * Barra fixa no topo (Gabriel, 28/11/2026): sem menu de módulos (o acesso é pelos cards da tela inicial);
 * só Voltar, Início (sempre leva aos cards), a logo e o menu do usuário (tema e sair).
 */
export function BarraTopo({ nome, perfil }: Props) {
  const router = useRouter();
  const naInicial = usePathname() === '/';

  function voltar() {
    // Sem página anterior nesta aba (link aberto direto): volta para o início.
    if (window.history.length > 1) router.back();
    else router.push('/');
  }

  const botao = 'inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors hover:bg-muted active:scale-95';
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-1 px-3 sm:gap-2 sm:px-6">
        <button type="button" onClick={voltar} className={botao} aria-label="Voltar para a tela anterior">
          <ArrowLeft className="size-5" aria-hidden />
          <span className="hidden min-[380px]:inline">Voltar</span>
        </button>
        <Link
          href="/"
          className={cn(botao, naInicial ? 'bg-accent text-accent-foreground hover:bg-accent' : '')}
          aria-current={naInicial ? 'page' : undefined}
        >
          <House className="size-5" aria-hidden />
          <span className="hidden min-[380px]:inline">Início</span>
        </Link>
        <Link href="/" aria-label="DHC Persianas e Cortinas, início" className="mx-auto flex h-9 items-center sm:h-10">
          <Logo className="h-full" />
        </Link>
        <MenuUsuario nome={nome} perfil={perfil} />
      </div>
      <div className="faixa-marca h-0.5 opacity-70" aria-hidden />
    </header>
  );
}

function iniciais(nome: string) {
  const p = nome.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

function MenuUsuario({ nome, perfil }: Props) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('pointerdown', fora);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', fora); document.removeEventListener('keydown', esc); };
  }, [aberto]);

  async function sair() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
    router.refresh();
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setAberto((a) => !a)}
        aria-expanded={aberto}
        aria-haspopup="menu"
        aria-label="Menu do usuário: tema e sair"
        className="flex items-center gap-2 rounded-full p-1 transition-colors hover:bg-muted sm:pr-3"
      >
        <span className="faixa-marca flex size-9 items-center justify-center rounded-full text-sm font-semibold text-white shadow-marca">
          {iniciais(nome)}
        </span>
        <span className="hidden max-w-32 truncate text-sm font-medium lg:inline">{nome.split(' ')[0]}</span>
      </button>
      {aberto && (
        <div role="menu" className="entrar absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border bg-card p-3 text-card-foreground shadow-marca">
          <div className="mb-3 px-1">
            <p className="truncate font-semibold">{nome}</p>
            <p className="text-xs text-muted-foreground">{perfil === 'ADMIN' ? 'Administrador' : 'Vendedor'}</p>
          </div>
          <p className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">Tema</p>
          <SeletorTema />
          <button
            type="button"
            role="menuitem"
            onClick={sair}
            className="mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="size-4" aria-hidden /> Sair
          </button>
        </div>
      )}
    </div>
  );
}
