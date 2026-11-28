'use client';
import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Tema = 'sistema' | 'claro' | 'escuro';

function ler(): Tema {
  try {
    const t = localStorage.getItem('tema');
    return t === 'claro' || t === 'escuro' ? t : 'sistema';
  } catch {
    return 'sistema';
  }
}

function aplicar(t: Tema) {
  const escuro = t === 'escuro' || (t === 'sistema' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', escuro);
}

/** Tema salvo no aparelho. "Sistema" acompanha o claro/escuro do iPhone ou do computador, inclusive quando muda sozinho à noite. */
export function useTema() {
  const [tema, setTema] = useState<Tema>('sistema');
  useEffect(() => {
    setTema(ler());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const mudou = () => { if (ler() === 'sistema') aplicar('sistema'); };
    mq.addEventListener('change', mudou);
    return () => mq.removeEventListener('change', mudou);
  }, []);
  function escolher(t: Tema) {
    try {
      if (t === 'sistema') localStorage.removeItem('tema');
      else localStorage.setItem('tema', t);
    } catch { /* aparelho sem armazenamento: vale só nesta tela */ }
    setTema(t);
    aplicar(t);
  }
  return { tema, escolher };
}

const OPCOES: { valor: Tema; rotulo: string; Icone: typeof Sun }[] = [
  { valor: 'sistema', rotulo: 'Sistema', Icone: Monitor },
  { valor: 'claro', rotulo: 'Claro', Icone: Sun },
  { valor: 'escuro', rotulo: 'Escuro', Icone: Moon },
];

export function SeletorTema() {
  const { tema, escolher } = useTema();
  return (
    <div role="radiogroup" aria-label="Tema" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
      {OPCOES.map(({ valor, rotulo, Icone }) => (
        <button
          key={valor}
          type="button"
          role="radio"
          aria-checked={tema === valor}
          onClick={() => escolher(valor)}
          className={cn(
            'flex flex-col items-center gap-1 rounded-md px-2 py-2 text-xs font-medium transition-colors',
            tema === valor ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icone className="size-4" aria-hidden />
          {rotulo}
        </button>
      ))}
    </div>
  );
}
