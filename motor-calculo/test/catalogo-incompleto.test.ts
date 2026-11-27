import { describe, expect, it } from 'vitest';
import { calcularCortina, calcularPersiana, criarCatalogo, PRODUTOS_SEED, ErroSkuNaoEncontrado } from '../src/index.js';

// Produção: Gabriel cadastra o catálogo à mão; serviços e acessórios podem ainda não existir.
const so = (...skus: string[]) => criarCatalogo(PRODUTOS_SEED.filter((p) => skus.includes(p.sku)));
const persianaManual = { sku: 'PER-001', medida: { tipo: 'PRODUCAO' as const, largura: '2', altura: '2' }, acionamento: 'MANUAL' as const, ladoComando: 'DIREITO' as const, sentidoEnrolamento: 'NORMAL' as const };

describe('catálogo sem os SKUs auxiliares', () => {
  it('persiana manual sem SRV-002 calcula e avisa que a instalação não foi cobrada', () => {
    const r = calcularPersiana(persianaManual, so('PER-001'));
    expect(r.componentes.map((c) => c.sku)).toEqual(['PER-001']);
    const a = r.alertas.find((x) => x.codigo === 'SKU_AUXILIAR_AUSENTE');
    expect(a?.skuSugerido).toBe('SRV-002');
    expect(a?.mensagem).toMatch(/instalação de persiana manual/);
  });

  it('persiana motorizada sem motor, controle e instalação: só o produto e 3 alertas', () => {
    const r = calcularPersiana({ ...persianaManual, acionamento: 'MOTORIZADO', possuiBando: true }, so('PER-001'));
    expect(r.componentes.map((c) => c.sku)).toEqual(['PER-001']);
    expect(r.alertas.filter((x) => x.codigo === 'SKU_AUXILIAR_AUSENTE').map((x) => x.skuSugerido)).toEqual(['ACP-001', 'MOT-001', 'MOT-002', 'SRV-003']);
  });

  it('o produto principal continua obrigatório', () => {
    expect(() => calcularPersiana(persianaManual, so())).toThrow(ErroSkuNaoEncontrado);
  });

  it('cortina só com o tecido: calcula o tecido e avisa o resto', () => {
    const r = calcularCortina({ larguraTrilho: '2', alturaPronta: '2.6', numFolhas: 2, confeccao: 'WAVE', tecido: { sku: 'TEC-001' } }, so('TEC-001'));
    expect(r.componentes.map((c) => c.sku)).toEqual(['TEC-001']);
    expect(r.alertas.filter((x) => x.codigo === 'SKU_AUXILIAR_AUSENTE').map((x) => x.skuSugerido))
      .toEqual(['TRI-002', 'MDO-001', 'DES-001', 'DES-003', 'FIX-001', 'FIX-002', 'SRV-001']);
  });

  it('com o catálogo completo não aparece o alerta', () => {
    const r = calcularPersiana(persianaManual, criarCatalogo(PRODUTOS_SEED));
    expect(r.alertas.some((x) => x.codigo === 'SKU_AUXILIAR_AUSENTE')).toBe(false);
  });
});
