import { describe, expect, it } from 'vitest';
import { PRODUTOS_SEED, regrasDoModelo } from '../src/index.js';

const obter = (sku: string) => PRODUTOS_SEED.find((p) => p.sku === sku);

describe('regras do modelo (quadro de atenção do vendedor)', () => {
  it('persiana: largura máxima, altura e área mínimas cobradas, redutor no manual', () => {
    const r = regrasDoModelo({ tipo: 'PERSIANA', persiana: 'PER-001', acionamento: 'MANUAL' }, obter);
    const titulos = r.map((x) => x.titulo);
    expect(titulos).toEqual(expect.arrayContaining(['Largura máxima', 'Altura mínima cobrada', 'Área mínima cobrada', 'Manual largo', 'Proporção']));
    expect(r.find((x) => x.titulo === 'Largura máxima')!.texto).toMatch(/^2,80 m por peça/);
    expect(r.find((x) => x.titulo === 'Área mínima cobrada')!.texto).toMatch(/1,50 m²/);
    // largura mínima 0 no exemplo: não aparece
    expect(titulos).not.toContain('Largura mínima');
    expect(regrasDoModelo({ tipo: 'PERSIANA', persiana: 'PER-001', acionamento: 'MOTORIZADO' }, obter).map((x) => x.titulo)).not.toContain('Manual largo');
  });

  it('cortina: rolo do tecido e do forro, barra do trilho, Wave em varão', () => {
    const r = regrasDoModelo({ tipo: 'CORTINA', tecido: 'TEC-001', forro: 'TEC-002', trilho: 'TRI-002', confeccao: 'WAVE' }, obter);
    expect(r.find((x) => x.titulo === 'Largura do rolo do tecido')!.texto).toMatch(/^3,00 m/);
    expect(r.find((x) => x.titulo === 'Barra máxima do trilho')!.texto).toMatch(/^6,00 m/);
    const varao = regrasDoModelo({ tipo: 'CORTINA', tecido: 'TEC-001', forro: 'TEC-002', trilho: 'TRI-003', confeccao: 'WAVE' }, obter).map((x) => x.titulo);
    expect(varao).toEqual(expect.arrayContaining(['Wave em varão', 'Forro']));
  });

  it('modelo não escolhido ou fora do catálogo: sem regras de produto', () => {
    expect(regrasDoModelo({ tipo: 'PERSIANA' }, obter)).toEqual([]);
    expect(regrasDoModelo({ tipo: 'PERSIANA', persiana: 'XXX' }, obter)).toEqual([]);
  });
});
