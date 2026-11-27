import { Decimal as DecimalBase } from 'decimal.js';

/**
 * Instância isolada do Decimal.js para o motor.
 * Precisão alta e arredondamento HALF_UP (padrão comercial brasileiro).
 * Nunca use Number/float para somar quantidades ou dinheiro.
 */
export const Decimal = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_UP,
});
export type Decimal = InstanceType<typeof Decimal>;

/** Valor aceito nas entradas: prefira string ("2.60") para evitar qualquer ruído de float. */
export type Numerico = string | number | DecimalBase;

export function d(v: Numerico): Decimal {
  if (v instanceof DecimalBase) return new Decimal(v.toString());
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ErroEntrada(`Número inválido: ${v}`);
    // String(n) usa a representação mais curta (0.1 -> "0.1"), evitando 0.1000000000000000055...
    return new Decimal(String(v));
  }
  const s = v.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new ErroEntrada(`Número inválido: "${v}"`);
  return new Decimal(s);
}

export const ZERO = new Decimal(0);
export const UM = new Decimal(1);

/** Arredonda PARA CIMA ao múltiplo de `passo` (ex.: 7,43 -> 7,50 com passo 0,10). */
export function ceilStep(valor: Decimal, passo: Numerico): Decimal {
  const s = d(passo);
  if (s.lte(0)) throw new ErroEntrada('Passo de arredondamento deve ser > 0');
  return valor.div(s).ceil().mul(s);
}

/** Dinheiro: 2 casas, HALF_UP. */
export function dinheiro(v: Decimal): Decimal {
  return v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Preço/custo unitário: 4 casas (NUMERIC(12,4) do banco). */
export function unitario(v: Decimal): Decimal {
  return v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export class ErroEntrada extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ErroEntrada';
  }
}

export function positivo(nome: string, v: Numerico): Decimal {
  const x = d(v);
  if (x.lte(0)) throw new ErroEntrada(`${nome} deve ser maior que zero (recebido ${x.toString()})`);
  return x;
}

export function naoNegativo(nome: string, v: Numerico): Decimal {
  const x = d(v);
  if (x.lt(0)) throw new ErroEntrada(`${nome} não pode ser negativo (recebido ${x.toString()})`);
  return x;
}
