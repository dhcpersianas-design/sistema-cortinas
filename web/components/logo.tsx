import { cn } from '@/lib/utils';

/** Logo da DHC sem fundo: versão com letras escuras no tema claro e letras claras no tema escuro. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-block', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-dhc-claro.png" alt="DHC Persianas & Cortinas" width={309} height={111} className="logo-clara h-full w-auto" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-dhc-escuro.png" alt="DHC Persianas & Cortinas" width={309} height={111} className="logo-escura h-full w-auto" />
    </span>
  );
}
