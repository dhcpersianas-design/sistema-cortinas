import { describe, expect, it } from 'vitest';
import { calcularCortina, catalogoSeed, d, deslizantesModelo, garrasModelo, garantiaDoItem, textoGarantia, totalizarOrcamento, type ModeloCortinaItem } from '../src/index.js';

/** Modelo pronto do exemplo do Gabriel (28/11/2026): wave com forro, acessórios por tecido e da cortina. */
const modelo: ModeloCortinaItem = {
  nome: 'Cortina Wave Linho + Forro',
  acessorios: [
    { sku: 'DES-002', aplica: 'PRIMARIO', regra: 'DESLIZANTE' },
    { sku: 'DES-003', aplica: 'PRIMARIO', regra: 'ENTRETELA' },
    { sku: 'DES-002', aplica: 'SECUNDARIO', regra: 'DESLIZANTE' },
    { sku: 'FIX-001', aplica: 'CORTINA', regra: 'TERMINAL' },
    { sku: 'FIX-002', aplica: 'CORTINA', regra: 'GARRA' },
  ],
  maoObra: 'MDO-001',
};

describe('regras do modelo de cortina', () => {
  it('deslizantes: wave cm/4 e franzido cm/8, sempre par', () => {
    expect(deslizantesModelo(d('2.50'), true).quantidade.toNumber()).toBe(64);
    expect(deslizantesModelo(d('2.50'), false).quantidade.toNumber()).toBe(32);
    expect(deslizantesModelo(d('2.00'), true).quantidade.toNumber()).toBe(50);
    expect(deslizantesModelo(d('2.10'), false).quantidade.toNumber()).toBe(28); // 26,25 -> 27 -> 28
  });

  it('garras: 1 em cada ponta + 1 a cada 40 cm', () => {
    expect(garrasModelo(d('1.60')).quantidade.toNumber()).toBe(5);
    expect(garrasModelo(d('2.50')).quantidade.toNumber()).toBe(8);
    expect(garrasModelo(d('0.40')).quantidade.toNumber()).toBe(2);
  });

  it('cortina wave 2,50 com forro pelo modelo', () => {
    const r = calcularCortina({ larguraTrilho: '2.50', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
      tecido: { sku: 'TEC-001' }, forro: { sku: 'TEC-002' }, skus: { trilho: 'TRI-002' }, modelo }, catalogoSeed);
    const q = (sku: string) => r.componentes.filter((c) => c.sku === sku).map((c) => c.quantidade.toNumber());
    expect(q('DES-002')).toEqual([64, 32]);
    expect(q('DES-003')).toEqual([7]); // 2,50 x 2,8
    expect(q('FIX-001')).toEqual([6]);
    expect(q('FIX-002')).toEqual([8]);
    expect(q('MDO-001')).toEqual([2.5]); // valor x largura do trilho, cortina inteira
    expect(q('MDO-002')).toEqual([]); // sem mão de obra separada do forro
    expect(q('DES-001')).toEqual([]); // códigos fixos não entram
    expect(q('SRV-001')).toEqual([1]);
    expect(r.alertas.filter((a) => a.codigo === 'SKU_AUXILIAR_AUSENTE')).toEqual([]);
  });

  it('sem tecido secundário: acessórios do secundário saem; prega não leva entretela', () => {
    const r = calcularCortina({ larguraTrilho: '2.50', alturaPronta: '2.60', numFolhas: 2, confeccao: 'PREGA',
      tecido: { sku: 'TEC-001' }, skus: { trilho: 'TRI-001' }, modelo }, catalogoSeed);
    const q = (sku: string) => r.componentes.filter((c) => c.sku === sku).map((c) => c.quantidade.toNumber());
    expect(q('DES-002')).toEqual([32]);
    expect(q('DES-003')).toEqual([]);
  });

  it('acessório do modelo sem cadastro vira alerta, sem travar', () => {
    const r = calcularCortina({ larguraTrilho: '2.00', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
      tecido: { sku: 'TEC-001' }, skus: { trilho: 'TRI-001' }, modelo: { nome: 'X', acessorios: [{ sku: 'NAO-EXISTE', aplica: 'CORTINA', regra: 'FIXA', quantidade: 2 }] } }, catalogoSeed);
    expect(r.alertas.some((a) => a.codigo === 'SKU_AUXILIAR_AUSENTE' && a.skuSugerido === 'NAO-EXISTE')).toBe(true);
  });
});

describe('ajustes de 28/11/2026', () => {
  it('cortina não tem garantia; persiana continua', () => {
    expect(textoGarantia(garantiaDoItem(['TEC-001', 'TRI-002'], catalogoSeed, 'CORTINA'))).toBe('');
    expect(textoGarantia(garantiaDoItem(['PER-002', 'MOT-001'], catalogoSeed, 'PERSIANA'))).toBe('2 anos; motor 5 anos');
  });

  it('orçamento sem itens não fica vermelho', () => {
    expect(totalizarOrcamento([], { descontoTipo: 'PERCENTUAL', descontoValor: '0', acrescimo: '0' }).semaforo).toBe('VERDE');
  });
});
