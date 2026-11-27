'use client';
import { useState } from 'react';
import { ALTERACAO_EM_MASSA } from '@sistema/motor-calculo/navegador';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Caixinha de segurança (Gabriel, 27/11/2026): para alteração em massa (mais de 10 itens)
 * e para troca de markup, só continua depois de digitar ALTERAR e clicar em Continuar.
 * `children` mostra o que vai mudar (quantidade e efeito nos preços).
 */
export function ConfirmarAlteracao({ titulo, children, aoContinuar, aoCancelar, ocupado }: {
  titulo: string;
  children?: React.ReactNode;
  aoContinuar: (palavra: string) => void;
  aoCancelar: () => void;
  ocupado?: boolean;
}) {
  const [texto, setTexto] = useState('');
  const ok = texto.trim().toUpperCase() === ALTERACAO_EM_MASSA.palavra;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="confirmar-titulo"
      onKeyDown={(e) => { if (e.key === 'Escape') aoCancelar(); }}>
      <form className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-lg border bg-card p-4 shadow-lg"
        onSubmit={(e) => { e.preventDefault(); if (ok && !ocupado) aoContinuar(texto.trim().toUpperCase()); }}>
        <h2 id="confirmar-titulo" className="text-lg font-semibold">{titulo}</h2>
        {children}
        <label className="flex flex-col gap-1.5 text-sm">
          <span>Para confirmar, digite <strong>{ALTERACAO_EM_MASSA.palavra}</strong>:</span>
          <Input autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} autoComplete="off" aria-label={`Digite ${ALTERACAO_EM_MASSA.palavra}`} />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={aoCancelar}>Cancelar</Button>
          <Button type="submit" disabled={!ok || ocupado}>{ocupado ? 'Aplicando…' : 'Continuar'}</Button>
        </div>
      </form>
    </div>
  );
}
