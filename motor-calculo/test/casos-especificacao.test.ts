import { describe, expect, it } from 'vitest';
import { calcularCortina, calcularPersiana, catalogoSeed, paraJSON, resumirOrcamento } from '../src/index.js';

/** Tabela compacta: sku -> [qtd, custoTotal, precoTotal] */
function tabela(r: ReturnType<typeof calcularCortina>) {
  return Object.fromEntries(
    r.componentes.map((c) => [c.sku, [c.quantidade.toString(), c.custoTotal.toFixed(2), c.precoTotal.toFixed(2)]]),
  );
}

const entradaCaso1 = {
  larguraTrilho: '3.00',
  alturaPronta: '2.60',
  numFolhas: 2 as const,
  confeccao: 'WAVE' as const,
  tecido: { sku: 'TEC-001', fator: '2.5', margemBarra: '0.30' },
  forro: { sku: 'TEC-002', fator: '2.0', margemBarra: '0.20', desconto: '0.05' },
  skus: { trilho: 'TRI-002' },
};

describe('Caso de teste 1 (seção 6): Cortina Wave linho c/ forro, trilho duplo', () => {
  const r = calcularCortina(entradaCaso1, catalogoSeed);

  it('explode exatamente os 11 componentes esperados', () => {
    expect(tabela(r)).toEqual({
      'TEC-001': ['7.5', '315.00', '825.00'],
      'TEC-002': ['6', '168.00', '450.00'],
      'MDO-001': ['7.5', '165.00', '412.50'],
      'MDO-002': ['6', '96.00', '240.00'],
      'TRI-002': ['3', '102.00', '267.00'],
      'DES-001': ['48', '67.20', '182.40'],
      'DES-002': ['30', '10.50', '36.00'],
      'DES-003': ['7.5', '26.25', '75.00'],
      'FIX-001': ['4', '10.00', '32.00'],
      'FIX-002': ['7', '14.00', '45.50'],
      'SRV-001': ['1', '80.00', '180.00'],
    });
    expect(r.componentes).toHaveLength(11);
  });

  it('bate os totais até o centavo', () => {
    expect(r.custoTotalItem.toFixed(2)).toBe('1053.95');
    expect(r.vendaTotalItem.toFixed(2)).toBe('2745.40');
    expect(r.lucroBrutoItem.toFixed(2)).toBe('1691.45');
    expect(r.margemBrutaPct.toFixed(2)).toBe('61.61');
  });

  it('usa corte horizontal nas duas camadas e não gera alertas', () => {
    expect(r.especificacaoTecnica.tecido).toMatchObject({ modoCorte: 'HORIZONTAL', alturaCorte: '2.90' });
    expect(r.especificacaoTecnica.forro).toMatchObject({ modoCorte: 'HORIZONTAL', alturaCorte: '2.75' });
    expect(r.alertas).toEqual([]);
  });
});

describe('Caso de teste 2 (seção 6): Persiana Rolo Tela Solar motorizada c/ bando', () => {
  const r = calcularPersiana(
    {
      sku: 'PER-001',
      medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.00' },
      acionamento: 'MOTORIZADO',
      ladoComando: 'DIREITO',
      sentidoEnrolamento: 'NORMAL',
      possuiBando: true,
    },
    catalogoSeed,
  );

  it('explode os 5 componentes esperados', () => {
    expect(tabela(r)).toEqual({
      'PER-001': ['1.68', '226.80', '537.60'],
      'ACP-001': ['1.4', '72.80', '189.00'],
      'MOT-001': ['1', '480.00', '1150.00'],
      'MOT-002': ['1', '75.00', '190.00'],
      'SRV-003': ['1', '110.00', '250.00'],
    });
  });

  it('bate os totais até o centavo', () => {
    expect(r.custoTotalItem.toFixed(2)).toBe('964.60');
    expect(r.vendaTotalItem.toFixed(2)).toBe('2316.60');
    expect(r.lucroBrutoItem.toFixed(2)).toBe('1352.00');
    expect(r.margemBrutaPct.toFixed(2)).toBe('58.36');
  });

  it('leva lado do comando e enrolamento para a ficha técnica', () => {
    expect(r.especificacaoTecnica).toMatchObject({ ladoComando: 'DIREITO', sentidoEnrolamento: 'NORMAL', alturaProducao: '1.00' });
  });
});

describe('Orçamento com os dois itens', () => {
  it('soma e calcula a margem consolidada', () => {
    const o = resumirOrcamento([
      { ambiente: 'Sala', descricao: 'Cortina Wave', resultado: calcularCortina(entradaCaso1, catalogoSeed) },
      {
        ambiente: 'Escritório',
        descricao: 'Persiana Rolo',
        resultado: calcularPersiana(
          { sku: 'PER-001', medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.00' }, acionamento: 'MOTORIZADO', ladoComando: 'DIREITO', sentidoEnrolamento: 'NORMAL', possuiBando: true },
          catalogoSeed,
        ),
      },
    ]);
    expect(o.vendaTotal.toFixed(2)).toBe('5062.00');
    expect(o.custoTotal.toFixed(2)).toBe('2018.55');
    expect(o.margemBrutaPct.toFixed(2)).toBe('60.12');
  });

  it('serializa como strings decimais (sem float)', () => {
    const j = paraJSON(calcularCortina(entradaCaso1, catalogoSeed));
    expect(j.vendaTotalItem).toBe('2745.40');
    expect(j.componentes[0]).toMatchObject({ quantidade: '7.50', custoUnitario: '42.0000', precoTotal: '825.00' });
    expect(JSON.stringify(j)).not.toMatch(/\d\.\d{5,}/);
  });
});
