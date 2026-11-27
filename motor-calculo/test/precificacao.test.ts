import { describe, expect, it } from 'vitest';
import { precoVendaSugerido, semaforoMargem } from '../src/index.js';

describe('Markup padrão e semáforo (v1.1)', () => {
  it('markup 100%: venda sugerida = 2x custo', () => {
    expect(precoVendaSugerido('42.00').toFixed(2)).toBe('84.00');
    expect(precoVendaSugerido('0.35').toFixed(2)).toBe('0.70');
    expect(precoVendaSugerido('10.00', '150').toFixed(2)).toBe('25.00');
  });

  it('semáforo: 45 verde, 44,99 amarelo, 35 amarelo, 34,99 vermelho com senha', () => {
    expect(semaforoMargem('45.00')).toEqual({ cor: 'VERDE', exigeSenhaAdmin: false });
    expect(semaforoMargem('44.99').cor).toBe('AMARELO');
    expect(semaforoMargem('35.00').cor).toBe('AMARELO');
    expect(semaforoMargem('34.99')).toEqual({ cor: 'VERMELHO', exigeSenhaAdmin: true });
  });

  it('limites editáveis pelo ADMIN', () => {
    expect(semaforoMargem('40', { verdeMinPct: '40', amareloMinPct: '30' }).cor).toBe('VERDE');
  });
});
