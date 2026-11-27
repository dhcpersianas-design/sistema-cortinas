import { describe, expect, it } from 'vitest';
import {
  calcularCortina,
  calcularDeslizantesWave,
  calcularGarrasTrilho,
  calcularPersiana,
  calcularTecidoML,
  criarCatalogo,
  decomporBarras,
  PRODUTOS_SEED,
  catalogoSeed,
  d,
  ErroEntrada,
  medidaProducao,
  type EntradaCortina,
  type EntradaPersiana,
} from '../src/index.js';

const qtd = (r: { componentes: { sku: string; quantidade: { toString(): string } }[] }, sku: string) =>
  r.componentes.find((c) => c.sku === sku)?.quantidade.toString();
const codigos = (r: { alertas: { codigo: string }[] }) => r.alertas.map((a) => a.codigo);

const persiana = (o: Partial<EntradaPersiana> = {}): EntradaPersiana => ({
  sku: 'PER-001',
  medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.00' },
  acionamento: 'MANUAL',
  ladoComando: 'ESQUERDO',
  sentidoEnrolamento: 'NORMAL',
  ...o,
});

const cortina = (o: Partial<EntradaCortina> = {}): EntradaCortina => ({
  larguraTrilho: '3.00',
  alturaPronta: '2.60',
  numFolhas: 2,
  confeccao: 'WAVE',
  tecido: { sku: 'TEC-001', fator: '2.5' },
  ...o,
});

describe('Persiana: mínimos de fábrica', () => {
  it('1,10 x 1,00 trava em 1,50 m² (área mínima)', () => {
    const r = calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '1.10', altura: '1.00' } }), catalogoSeed);
    const per = r.componentes.find((c) => c.sku === 'PER-001')!;
    expect(per.quantidade.toFixed(4)).toBe('1.5000');
    expect(per.precoTotal.toFixed(2)).toBe('480.00');
    expect(per.formulaLog).toContain('1.3200');
  });

  it('aplica altura mínima 1,20 antes da área', () => {
    const r = calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '2.00', altura: '0.80' } }), catalogoSeed);
    expect(qtd(r, 'PER-001')).toBe('2.4');
  });

  it('mantém 4 casas na área (1,234 x 1,567)', () => {
    const r = calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '1.234', altura: '1.567' } }), catalogoSeed);
    // 1.234 * 1.567 = 1.933678 -> 1.9337
    expect(r.componentes[0]!.quantidade.toFixed(4)).toBe('1.9337');
  });

  it('manual usa SRV-002, sem motor nem controle', () => {
    const r = calcularPersiana(persiana(), catalogoSeed);
    expect(r.componentes.map((c) => c.sku)).toEqual(['PER-001', 'SRV-002']);
  });
});

describe('Persiana: medida de produção a partir do vão bruto', () => {
  it('DENTRO_VAO usa a menor das 3 larguras e desconta 1 cm', () => {
    const m = medidaProducao({ tipo: 'VAO_BRUTO', modo: 'DENTRO_VAO', largura: ['1.52', '1.50', '1.51'], altura: '1.60' });
    expect(m.largura.toFixed(2)).toBe('1.49');
    expect(m.altura.toFixed(2)).toBe('1.59');
  });

  it('FORA_VAO soma 0,20 na largura e 0,25 na altura', () => {
    const m = medidaProducao({ tipo: 'VAO_BRUTO', modo: 'FORA_VAO', largura: '1.20', altura: '1.30' });
    expect([m.largura.toFixed(2), m.altura.toFixed(2)]).toEqual(['1.40', '1.55']);
  });

  it('TETO soma 0,20 na largura e mantém a altura', () => {
    const m = medidaProducao({ tipo: 'VAO_BRUTO', modo: 'TETO', largura: '2.00', altura: '2.50' });
    expect([m.largura.toFixed(2), m.altura.toFixed(2)]).toEqual(['2.20', '2.50']);
  });

  it('grava o vão bruto na ficha técnica', () => {
    const r = calcularPersiana(persiana({ medida: { tipo: 'VAO_BRUTO', modo: 'FORA_VAO', largura: '1.20', altura: '1.30' } }), catalogoSeed);
    expect(r.especificacaoTecnica.vaoBruto).toEqual({ largura: '1.20', altura: '1.30', modo: 'FORA_VAO' });
    expect(r.especificacaoTecnica.larguraProducao).toBe('1.40');
  });
});

describe('Persiana: alertas técnicos', () => {
  it('largura acima do rolo + manual largo', () => {
    const r = calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '3.00', altura: '2.00' } }), catalogoSeed);
    expect(codigos(r)).toEqual(['LARGURA_EXCEDE_ROLO', 'SUGERIR_REDUTOR_PESO']);
    expect(r.alertas[1]!.skuSugerido).toBe('ACP-003');
  });

  it('2,40 exatos não sugere redutor; 2,41 sugere', () => {
    expect(codigos(calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '2.40', altura: '2.00' } }), catalogoSeed))).toEqual([]);
    expect(codigos(calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '2.41', altura: '2.00' } }), catalogoSeed))).toEqual(['SUGERIR_REDUTOR_PESO']);
  });

  it('motorizado largo não sugere redutor', () => {
    const r = calcularPersiana(persiana({ acionamento: 'MOTORIZADO', medida: { tipo: 'PRODUCAO', largura: '2.60', altura: '2.00' } }), catalogoSeed);
    expect(codigos(r)).toEqual([]);
  });

  it('incluirRedutorPeso adiciona ACP-003 em vez de alertar', () => {
    const r = calcularPersiana(persiana({ incluirRedutorPeso: true, medida: { tipo: 'PRODUCAO', largura: '2.60', altura: '2.00' } }), catalogoSeed);
    expect(qtd(r, 'ACP-003')).toBe('1');
    expect(codigos(r)).toEqual([]);
  });

  it('telescopagem quando H > 2,5 x L', () => {
    expect(codigos(calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '0.60', altura: '1.80' } }), catalogoSeed))).toEqual(['AREA_ABAIXO_MINIMO', 'RISCO_TELESCOPAGEM']);
    expect(codigos(calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '0.60', altura: '1.50' } }), catalogoSeed))).toEqual(['AREA_ABAIXO_MINIMO']);
  });

  it('regras do modelo: área e altura abaixo do mínimo e altura acima do máximo avisam o vendedor', () => {
    expect(codigos(calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '1.20', altura: '1.00' } }), catalogoSeed)))
      .toEqual(['ALTURA_ABAIXO_MINIMO', 'AREA_ABAIXO_MINIMO']);
    const cat = criarCatalogo(PRODUTOS_SEED.map((p) => (p.sku === 'PER-001' ? { ...p, metadata: { ...p.metadata, larg_min: 0.4, alt_max: 3.0 } } : p)));
    const r = calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '0.30', altura: '3.20' } }), cat);
    expect(codigos(r)).toEqual(expect.arrayContaining(['LARGURA_ABAIXO_MINIMO', 'ALTURA_EXCEDE_MAXIMO']));
    expect(r.alertas.find((a) => a.codigo === 'ALTURA_EXCEDE_MAXIMO')!.severidade).toBe('CRITICO');
  });

  it('dividir vão em 2 peças elimina o alerta de largura e fatura por peça', () => {
    const r = calcularPersiana(persiana({ numPecas: 2, acionamento: 'MOTORIZADO', medida: { tipo: 'PRODUCAO', largura: '3.00', altura: '2.00' } }), catalogoSeed);
    expect(codigos(r)).toEqual([]);
    expect(qtd(r, 'PER-001')).toBe('6'); // 2 x (1,50 x 2,00)
    expect(qtd(r, 'MOT-001')).toBe('2');
    expect(qtd(r, 'MOT-002')).toBe('1'); // controle não é 1:1
    expect(qtd(r, 'SRV-003')).toBe('2');
  });

  it('mínimo de área vale por peça ao dividir', () => {
    const r = calcularPersiana(persiana({ numPecas: 2, medida: { tipo: 'PRODUCAO', largura: '2.00', altura: '1.00' } }), catalogoSeed);
    expect(qtd(r, 'PER-001')).toBe('3'); // 1,00 x 1,20 = 1,20 -> 1,50 por peça
  });
});

describe('Persiana: acabamentos e automação', () => {
  it('bando com mínimo 1,00 ML', () => {
    const r = calcularPersiana(persiana({ possuiBando: true, medida: { tipo: 'PRODUCAO', largura: '0.70', altura: '1.30' } }), catalogoSeed);
    expect(qtd(r, 'ACP-001')).toBe('1');
  });

  it('guia lateral 2H, + L com calha inferior', () => {
    const sem = calcularPersiana(persiana({ possuiGuiaLateral: true, medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.60' } }), catalogoSeed);
    const com = calcularPersiana(persiana({ possuiGuiaLateral: true, possuiCalhaInferior: true, medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.60' } }), catalogoSeed);
    expect(qtd(sem, 'ACP-002')).toBe('3.2');
    expect(qtd(com, 'ACP-002')).toBe('4.6');
  });

  it('segunda persiana do ambiente com qtdControles = 0 e hub opcional', () => {
    const r = calcularPersiana(persiana({ acionamento: 'MOTORIZADO', qtdControles: 0, qtdHubs: 1 }), catalogoSeed);
    expect(r.componentes.map((c) => c.sku)).toEqual(['PER-001', 'MOT-001', 'MOT-003', 'SRV-003']);
  });
});

describe('Cortina: sentido de corte', () => {
  it('pé-direito duplo vai para corte em tiras', () => {
    const r = calcularTecidoML({
      larguraTrilho: d('3.00'), alturaPronta: d('4.50'), fator: d('2.5'), numFolhas: 2,
      larguraRolo: d('3.00'), permiteCorteHorizontal: true, margemBarra: d('0.30'),
    });
    // 7,50 / 3,00 = 2,5 -> 3 tiras * 4,80 = 14,40
    expect(r.modoCorte).toBe('VERTICAL_TIRAS');
    expect(r.numTiras!.toString()).toBe('3');
    expect(r.quantidade.toFixed(2)).toBe('14.40');
  });

  it('simetria de tiras com 2 folhas arredonda para número par', () => {
    const r = calcularTecidoML({
      larguraTrilho: d('3.00'), alturaPronta: d('4.50'), fator: d('2.5'), numFolhas: 2,
      larguraRolo: d('3.00'), permiteCorteHorizontal: true, margemBarra: d('0.30'), exigirSimetriaTiras: true,
    });
    expect(r.numTiras!.toString()).toBe('4');
    expect(r.quantidade.toFixed(2)).toBe('19.20');
  });

  it('tecido que não permite virar trama vai para tiras mesmo cabendo no rolo', () => {
    const r = calcularTecidoML({
      larguraTrilho: d('2.00'), alturaPronta: d('2.50'), fator: d('2'), numFolhas: 1,
      larguraRolo: d('3.00'), permiteCorteHorizontal: false, margemBarra: d('0.30'),
    });
    // 4,00 / 3,00 -> 2 tiras * 2,80 = 5,60
    expect(r.modoCorte).toBe('VERTICAL_TIRAS');
    expect(r.quantidade.toFixed(2)).toBe('5.60');
  });

  it('H_corte exatamente igual ao rolo ainda é horizontal (2,70 + 0,30 = 3,00)', () => {
    const r = calcularCortina(cortina({ alturaPronta: '2.70' }), catalogoSeed);
    expect(r.especificacaoTecnica.tecido).toMatchObject({ modoCorte: 'HORIZONTAL' });
    expect(codigos(r)).toEqual([]);
  });

  it('arredonda o consumo para cima ao múltiplo de 0,10 (2,33 x 2,5 = 5,825 -> 5,90)', () => {
    const r = calcularCortina(cortina({ larguraTrilho: '2.33' }), catalogoSeed);
    expect(qtd(r, 'TEC-001')).toBe('5.9');
  });

  it('fita wave em tiras usa largura esticada, não o consumo do tecido', () => {
    const r = calcularCortina(cortina({ alturaPronta: '4.50' }), catalogoSeed);
    expect(qtd(r, 'TEC-001')).toBe('14.4');
    expect(qtd(r, 'DES-003')).toBe('7.5');
    expect(codigos(r)).toContain('CORTE_EM_TIRAS');
  });
});

describe('Cortina: deslizantes, garras e trilho', () => {
  it('paridade Wave por folha', () => {
    expect(calcularDeslizantesWave(d('3.00'), 2, d(15)).quantidade.toString()).toBe('48');
    expect(calcularDeslizantesWave(d('1.10'), 1, d(15)).quantidade.toString()).toBe('18'); // 16,5 -> 18
    expect(calcularDeslizantesWave(d('2.00'), 1, d(15)).quantidade.toString()).toBe('30');
    expect(calcularDeslizantesWave(d('2.10'), 2, d(15)).quantidade.toString()).toBe('32'); // 15,75 -> 16 por folha
  });

  it('garras com mínimo de 2', () => {
    expect(calcularGarrasTrilho(d('0.40'), d('0.50'), d(2)).quantidade.toString()).toBe('2');
    expect(calcularGarrasTrilho(d('3.10'), d('0.50'), d(2)).quantidade.toString()).toBe('8');
  });

  it('trilho com mínimo faturável 1,00 ML', () => {
    const r = calcularCortina(cortina({ larguraTrilho: '0.80', numFolhas: 1 }), catalogoSeed);
    expect(qtd(r, 'TRI-002')).toBe('1');
  });

  it('trilho cobrado por barra em metro inteiro: 1,50 -> 2 m; 2,20 -> 3 m; 3,00 -> 3 m', () => {
    expect(qtd(calcularCortina(cortina({ larguraTrilho: '1.50' }), catalogoSeed), 'TRI-002')).toBe('2');
    expect(qtd(calcularCortina(cortina({ larguraTrilho: '2.20' }), catalogoSeed), 'TRI-002')).toBe('3');
    expect(qtd(calcularCortina(cortina({ larguraTrilho: '2.01' }), catalogoSeed), 'TRI-002')).toBe('3');
    expect(qtd(calcularCortina(cortina({ larguraTrilho: '3.00' }), catalogoSeed), 'TRI-002')).toBe('3');
  });

  it('garras e deslizantes usam a medida real, não a barra cobrada', () => {
    const r = calcularCortina(cortina({ larguraTrilho: '2.20' }), catalogoSeed);
    expect(qtd(r, 'FIX-002')).toBe('6'); // CEIL(2,20/0,50)+1
  });

  it('6,00 m é uma barra inteira, sem emenda e sem alerta de barra', () => {
    const r = calcularCortina(cortina({ larguraTrilho: '6.00' }), catalogoSeed);
    expect(qtd(r, 'TRI-002')).toBe('6');
    expect(qtd(r, 'FIX-003')).toBeUndefined();
    expect(codigos(r)).toEqual([]);
  });

  it('decompõe em barras de 6 m + resto arredondado ao metro', () => {
    const bar = (l: string) => decomporBarras(d(l), d('6.00'), d('1.00')).map((b) => `${b.quantidade}x${b.tamanho}`);
    expect(bar('1.50')).toEqual(['1x2']);
    expect(bar('6.00')).toEqual(['1x6']);
    expect(bar('6.10')).toEqual(['1x6', '1x1']);
    expect(bar('8.40')).toEqual(['1x6', '1x3']);
    expect(bar('12.00')).toEqual(['2x6']);
    expect(bar('12.50')).toEqual(['2x6', '1x1']);
  });

  it('6,10 m = barra de 6 m + barra de 1 m, com alerta e sem emenda', () => {
    const r = calcularCortina(cortina({ larguraTrilho: '6.10' }), catalogoSeed);
    expect(qtd(r, 'TRI-002')).toBe('7');
    expect(qtd(r, 'FIX-003')).toBeUndefined();
    expect(codigos(r)).toEqual(['TRILHO_ACIMA_BARRA_MAX']);
    expect(r.alertas[0]!.mensagem).toContain('1 barra(s) de 6 m + 1 barra(s) de 1 m');
    expect((r.especificacaoTecnica.trilho as { barras: unknown }).barras).toEqual([
      { tamanhoM: '6.00', quantidade: 1 },
      { tamanhoM: '1.00', quantidade: 1 },
    ]);
  });

  it('com tabela de preço por tamanho de barra, cobra cada barra pelo seu preço', () => {
    const precos_barra = {
      '1': { custo: '20.00', venda: '55.00' },
      '2': { custo: '36.00', venda: '100.00' },
      '6': { custo: '96.00', venda: '270.00' },
    };
    const cat = criarCatalogo(
      PRODUTOS_SEED.map((p) => (p.sku === 'TRI-001' ? { ...p, metadata: { ...p.metadata, precos_barra } } : p)),
    );
    const r = calcularCortina(cortina({ confeccao: 'PREGA', larguraTrilho: '6.10', skus: { trilho: 'TRI-001', maoObraTecido: 'MDO-003' } }), cat);
    const linhas = r.componentes.filter((c) => c.sku === 'TRI-001').map((c) => [c.descricao, c.unidade, c.quantidade.toString(), c.precoTotal.toFixed(2)]);
    expect(linhas).toEqual([
      ['Trilho Suico Max Simples - barra 6 m', 'PC', '1', '270.00'],
      ['Trilho Suico Max Simples - barra 1 m', 'PC', '1', '55.00'],
    ]);
    // tamanho sem preço na tabela gera erro claro
    expect(() => calcularCortina(cortina({ confeccao: 'PREGA', larguraTrilho: '2.50', skus: { trilho: 'TRI-001', maoObraTecido: 'MDO-003' } }), cat)).toThrow(/barra de 3 m/);
  });

  it('prega usa deslizantes comuns e mão de obra própria, sem fita wave', () => {
    const r = calcularCortina(
      cortina({ confeccao: 'PREGA', tecido: { sku: 'TEC-001', fator: '2.5' }, skus: { trilho: 'TRI-001', maoObraTecido: 'MDO-003' } }),
      catalogoSeed,
    );
    expect(r.componentes.map((c) => c.sku)).toEqual(['TEC-001', 'MDO-003', 'TRI-001', 'DES-002', 'FIX-001', 'FIX-002', 'SRV-001']);
    expect(qtd(r, 'DES-002')).toBe('30');
    expect(qtd(r, 'FIX-001')).toBe('2');
  });

  it('varão usa suportes (2 + CEIL(L - 2)) e bloqueia Wave', () => {
    const r = calcularCortina(cortina({ larguraTrilho: '2.50', skus: { trilho: 'TRI-003' } }), catalogoSeed);
    expect(qtd(r, 'FIX-002')).toBe('3');
    expect(qtd(r, 'FIX-001')).toBeUndefined();
    expect(codigos(r)).toContain('WAVE_EM_VARAO');
  });
});

describe('Cortina: faixas de instalação (v1.1)', () => {
  it('até 3,00 m usa SRV-001; acima usa SRV-004 (2x), sem tamanho máximo', () => {
    const inst = (l: string) => {
      const r = calcularCortina(cortina({ larguraTrilho: l }), catalogoSeed);
      return r.componentes.filter((c) => c.sku.startsWith('SRV-')).map((c) => `${c.sku}:${c.precoTotal.toFixed(2)}`);
    };
    expect(inst('3.00')).toEqual(['SRV-001:180.00']);
    expect(inst('3.01')).toEqual(['SRV-004:360.00']);
    expect(inst('9.50')).toEqual(['SRV-004:360.00']);
  });

  it('SRV-004 vale 2x o SRV-001 no catálogo fictício', () => {
    const a = catalogoSeed.obter('SRV-001');
    const b = catalogoSeed.obter('SRV-004');
    expect(d(b.precoVendaUnitario).eq(d(a.precoVendaUnitario).mul(2))).toBe(true);
    expect(d(b.custoUnitario).eq(d(a.custoUnitario).mul(2))).toBe(true);
  });
});

describe('Cortina: pé-direito alto, cortineiro e forro', () => {
  it('H > 3,00 aplica multiplicador do SKU na mão de obra e alerta andaime', () => {
    const r = calcularCortina(cortina({ alturaPronta: '3.20', forro: { sku: 'TEC-002', fator: '2' } }), catalogoSeed);
    const mdo1 = r.componentes.find((c) => c.sku === 'MDO-001')!;
    const mdo2 = r.componentes.find((c) => c.sku === 'MDO-002')!;
    expect(mdo1.custoUnitario.toFixed(2)).toBe('28.60'); // 22 x 1,30
    expect(mdo1.precoUnitario.toFixed(2)).toBe('71.50'); // 55 x 1,30
    expect(mdo2.precoUnitario.toFixed(2)).toBe('50.00'); // 40 x 1,25
    expect(codigos(r)).toContain('PE_DIREITO_ALTO');
    expect(qtd(r, 'SRV-006')).toBe('1');
  });

  it('3,00 exatos não aplica adicional', () => {
    const r = calcularCortina(cortina({ alturaPronta: '3.00' }), catalogoSeed);
    expect(codigos(r)).not.toContain('PE_DIREITO_ALTO');
    expect(qtd(r, 'SRV-006')).toBeUndefined();
  });

  it('cortineiro raso para Wave com forro em trilho duplo', () => {
    const base = { forro: { sku: 'TEC-002', fator: '2' } };
    expect(codigos(calcularCortina(cortina({ ...base, profundidadeCortineiroM: '0.16' }), catalogoSeed))).toEqual(['CORTINEIRO_RASO']);
    expect(codigos(calcularCortina(cortina({ ...base, profundidadeCortineiroM: '0.20' }), catalogoSeed))).toEqual(['CORTINEIRO_NO_LIMITE']);
    expect(codigos(calcularCortina(cortina({ ...base, profundidadeCortineiroM: '0.22' }), catalogoSeed))).toEqual([]);
  });

  it('cortineiro de Wave simples exige 15 cm', () => {
    expect(codigos(calcularCortina(cortina({ profundidadeCortineiroM: '0.14' }), catalogoSeed))).toEqual(['CORTINEIRO_RASO']);
    expect(codigos(calcularCortina(cortina({ profundidadeCortineiroM: '0.15' }), catalogoSeed))).toEqual([]);
  });

  it('forro em trilho de 1 via gera alerta', () => {
    const r = calcularCortina(cortina({ forro: { sku: 'TEC-002', fator: '2' }, skus: { trilho: 'TRI-001' } }), catalogoSeed);
    expect(codigos(r)).toContain('FORRO_SEM_VIA');
  });
});

describe('Precisão e validação', () => {
  it('aceita número JS sem herdar erro de float (0,1 + 0,2 = 0,3)', () => {
    expect(d(0.1).plus(d(0.2)).toString()).toBe('0.3');
  });

  it('aceita vírgula decimal', () => {
    expect(d('2,60').toFixed(2)).toBe('2.60');
  });

  it('rejeita entradas inválidas', () => {
    expect(() => calcularCortina(cortina({ larguraTrilho: '0' }), catalogoSeed)).toThrow(ErroEntrada);
    expect(() => calcularCortina(cortina({ larguraTrilho: 'abc' }), catalogoSeed)).toThrow(ErroEntrada);
    expect(() => calcularCortina(cortina({ numFolhas: 3 as 1 }), catalogoSeed)).toThrow(ErroEntrada);
    expect(() => calcularPersiana(persiana({ sku: 'XXX-999' }), catalogoSeed)).toThrow(/SKU não encontrado/);
    expect(() => calcularPersiana(persiana({ numPecas: 0 }), catalogoSeed)).toThrow(ErroEntrada);
  });

  it('resultado não depende de float: valores que quebram em Number batem exato', () => {
    // 1,15 x 1,30 em float = 1.4949999999999999 ; em decimal = 1,495 -> mínimo 1,50
    const r = calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '1.15', altura: '1.30' } }), catalogoSeed);
    expect(r.componentes[0]!.quantidade.toFixed(4)).toBe('1.5000');
    const r2 = calcularPersiana(persiana({ medida: { tipo: 'PRODUCAO', largura: '1.15', altura: '1.33' } }), catalogoSeed);
    expect(r2.componentes[0]!.quantidade.toFixed(4)).toBe('1.5295');
  });
});
