import { describe, expect, it } from 'vitest';
import { d, tetoDesconto, totalizarOrcamento } from '../src/index.js';

const itens = [{ vendaTotal: '1000.00', custoTotal: '400.00' }, { vendaTotal: '500.00', custoTotal: '150.00' }];
const p = { taxaPagamentoPct: '1.37', comissaoPct: '5', aliquotaImpostoPct: '0' };

describe('teto de desconto', () => {
  it('maior desconto que mantém a margem no alvo (45%)', () => {
    const t = tetoDesconto(itens, 0, p, 45);
    // total mínimo = 550 / (1 - 0,45 - 0,0637) = 1130,99...
    expect(t.valor.toFixed(2)).toBe('369.01');
    const ok = totalizarOrcamento(itens, { descontoTipo: 'VALOR', descontoValor: t.valor.toFixed(2) }, p);
    expect(ok.margemLiquidaPct.gte(45)).toBe(true);
    const passa = totalizarOrcamento(itens, { descontoTipo: 'VALOR', descontoValor: t.valor.plus('0.50').toFixed(2) }, p);
    expect(passa.margemLiquidaPct.lt(45)).toBe(true);
    expect(t.pct.toFixed(2)).toBe('24.60');
  });

  it('acréscimo aumenta o teto; margem já abaixo do alvo dá zero', () => {
    expect(tetoDesconto(itens, 100, p, 45).valor.gt(tetoDesconto(itens, 0, p, 45).valor)).toBe(true);
    expect(tetoDesconto([{ vendaTotal: '100', custoTotal: '90' }], 0, p, 45).valor.toFixed(2)).toBe('0.00');
    expect(tetoDesconto([], 0, p, 45).valor.toFixed(2)).toBe('0.00');
  });

  it('nunca passa do subtotal (custo zero)', () => {
    expect(tetoDesconto([{ vendaTotal: '200', custoTotal: '0' }], 0, {}, 35).valor.lte(d(200))).toBe(true);
  });
});
