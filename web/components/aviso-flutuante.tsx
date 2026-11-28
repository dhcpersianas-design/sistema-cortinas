'use client';
import { useEffect, useState } from 'react';

/**
 * Balão verde claro no canto inferior direito ("Produto salvo"). Some sozinho em 4 s.
 * `avisar` funciona mesmo trocando de tela: guarda a mensagem e a próxima tela mostra.
 */
const CHAVE = 'aviso-flutuante';
const EVENTO = 'aviso-flutuante';

export function avisar(mensagem: string) {
  try { sessionStorage.setItem(CHAVE, mensagem); } catch { /* sem storage: mostra só nesta tela */ }
  window.dispatchEvent(new CustomEvent(EVENTO, { detail: mensagem }));
}

export function AvisoFlutuante() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const mostrar = (m: string) => {
      try { sessionStorage.removeItem(CHAVE); } catch { /* ignora */ }
      setMsg(m);
    };
    try { const m = sessionStorage.getItem(CHAVE); if (m) mostrar(m); } catch { /* ignora */ }
    const ouvir = (e: Event) => mostrar((e as CustomEvent<string>).detail);
    window.addEventListener(EVENTO, ouvir);
    return () => window.removeEventListener(EVENTO, ouvir);
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return (
    <div role="status" aria-live="polite" style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      className="fixed right-4 z-50 flex max-w-xs items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-lg dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
      <span aria-hidden>✓</span>
      <span className="flex-1">{msg}</span>
      <button type="button" onClick={() => setMsg(null)} className="text-emerald-700/70 hover:text-emerald-900 dark:text-emerald-300/70" aria-label="Fechar">×</button>
    </div>
  );
}
