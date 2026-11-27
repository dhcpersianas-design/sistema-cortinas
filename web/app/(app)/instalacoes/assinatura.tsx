'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Quadro para o cliente assinar com o dedo (ou caneta/mouse). Funciona sem internet.
 * Devolve a assinatura como PNG (data URL) pelo onChange; null quando está em branco.
 */
export function QuadroAssinatura({ onChange }: { onChange: (png: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const desenhando = useRef(false);
  const ultimo = useRef<{ x: number; y: number } | null>(null);
  const [vazio, setVazio] = useState(true);
  const aviso = useRef(onChange);
  aviso.current = onChange;

  useEffect(() => {
    const c = ref.current!;
    let larguraAnterior = 0;
    const ajustar = () => {
      // No celular a barra de endereço some/aparece ao rolar e dispara "resize" sem mudar a largura:
      // só refaz (e apaga) quando a largura muda de verdade (ex.: girar a tela).
      const largura = Math.round(c.getBoundingClientRect().width);
      if (largura === larguraAnterior) return;
      larguraAnterior = largura;
      // Resolução da tela (nítido no celular), limitada para o PNG não ficar grande.
      const escala = Math.min(window.devicePixelRatio || 1, 2);
      const r = c.getBoundingClientRect();
      c.width = Math.round(r.width * escala);
      c.height = Math.round(r.height * escala);
      const ctx = c.getContext('2d')!;
      ctx.scale(escala, escala);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111827';
      setVazio(true);
      aviso.current(null);
    };
    ajustar();
    // Girar o celular redimensiona o quadro (e apaga o que foi desenhado).
    window.addEventListener('resize', ajustar);
    return () => window.removeEventListener('resize', ajustar);
  }, []);

  const ponto = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function inicio(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    desenhando.current = true;
    ultimo.current = ponto(e);
    const ctx = ref.current!.getContext('2d')!;
    ctx.beginPath();
    ctx.arc(ultimo.current.x, ultimo.current.y, 1, 0, Math.PI * 2);
    ctx.fillStyle = '#111827';
    ctx.fill();
  }
  function mover(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!desenhando.current || !ultimo.current) return;
    const p = ponto(e);
    const ctx = ref.current!.getContext('2d')!;
    ctx.beginPath();
    ctx.moveTo(ultimo.current.x, ultimo.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ultimo.current = p;
  }
  function fim() {
    if (!desenhando.current) return;
    desenhando.current = false;
    ultimo.current = null;
    setVazio(false);
    aviso.current(ref.current!.toDataURL('image/png'));
  }
  function limpar() {
    const c = ref.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setVazio(true);
    aviso.current(null);
  }

  return (
    <div className="space-y-2">
      <div className="relative rounded-md border-2 border-dashed bg-white">
        <canvas
          ref={ref}
          className="block h-48 w-full touch-none"
          onPointerDown={inicio} onPointerMove={mover} onPointerUp={fim} onPointerCancel={fim} onPointerLeave={fim}
          aria-label="Quadro de assinatura"
        />
        {vazio && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-400">Assine aqui com o dedo</span>}
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={limpar}>Limpar assinatura</Button>
    </div>
  );
}
