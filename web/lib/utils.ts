import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...entradas: ClassValue[]) {
  return twMerge(clsx(entradas));
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Formata string decimal vinda da API só para exibição (nunca para conta). */
export function dinheiro(v: string | null | undefined) {
  return v == null ? '—' : brl.format(Number(v));
}
