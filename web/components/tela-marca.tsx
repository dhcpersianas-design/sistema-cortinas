import { Logo } from '@/components/logo';

/** Moldura das telas fora do sistema (login, nova senha, sem conexão): logo no topo e cartão central. */
export function TelaMarca({ titulo, subtitulo, children }: { titulo: string; subtitulo?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-[max(2rem,env(safe-area-inset-top))]">
      <div className="entrar w-full max-w-sm">
        <div className="mb-8 flex justify-center"><Logo className="h-16 sm:h-20" /></div>
        <div className="overflow-hidden rounded-2xl border bg-card shadow-marca">
          <div className="faixa-marca h-1" aria-hidden />
          <div className="p-6 sm:p-7">
            <h1 className="text-xl font-bold tracking-tight">{titulo}</h1>
            {subtitulo && <p className="mt-1 text-sm text-muted-foreground">{subtitulo}</p>}
            {children && <div className="mt-6">{children}</div>}
          </div>
        </div>
      </div>
    </main>
  );
}
