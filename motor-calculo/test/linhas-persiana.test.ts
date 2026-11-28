import { describe, expect, it } from 'vitest';
import { adicionaisCompativeis, bandosDoModelo, calcularItem, calcularPersiana, criarCatalogo, descricaoComercial, PRODUTOS_SEED, regrasDoModelo, type Produto } from '../src/index.js';

const MAGIC: Produto = {
  sku: 'TST-MAGIC', nome: 'Cortina Magic Translúcida', unidade: 'M2', custoUnitario: '242.00', precoVendaUnitario: '484.00',
  metadata: {
    alt_max: 3.5, prazo_fabrica_dias: 7, enrolavel: false, motor_incluso: true,
    acionamentos: ['DD', 'DE', 'D', 'E', 'EL', 'ED'],
    limites_por_opcao: { MOTORIZADO: { alt_max: 3.5 } },
    adicionais: [
      { codigo: 'TRILHO_MOTORIZADO', rotulo: 'Trilho motorizado', tipo: 'CUSTO_ML', valor: 385, automatico: { motorizado: true } },
      { codigo: 'MOTOR_WIFI', rotulo: 'Motor Magic Wi-Fi com controle 6 canais', tipo: 'CUSTO_PECA', valor: 715, automatico: { motorizado: true } },
    ],
  },
};

const ROMANA: Produto = {
  sku: 'TST-ROM', nome: 'Romana Almansa Translúcido', unidade: 'M2', custoUnitario: '155.15', precoVendaUnitario: '310.30',
  metadata: {
    area_min: 1.2, larg_max: 3.0, alt_max: 4.0, area_max: 4.0, larg_max_consulta: 6, alt_max_consulta: 6,
    enrolavel: false, avisos: ['Comando com corrente bola nº 10.'],
    limites_por_opcao: { CASCATA: { alt_max: 3.0, area_max: 3.0 } },
    adicionais: [
      { codigo: 'CASCATA', rotulo: 'Romana cascata', tipo: 'CUSTO_M2', valor: 55, descricao: 'cascata' },
      { codigo: 'DEGRADE', rotulo: 'Degradê', tipo: 'PCT', valor: 10 },
      { codigo: 'COMANDO_ALIVIO', rotulo: 'Comando de alívio', tipo: 'CUSTO_PECA', valor: 26.75, sugerir_area_acima: 3 },
    ],
  },
};

const PH25: Produto = {
  sku: 'TST-PH25', nome: 'PH 25 mm Básica', unidade: 'M2', custoUnitario: '96.30', precoVendaUnitario: '192.60',
  metadata: {
    area_min: 1.0, larg_min_producao: 0.25, enrolavel: false,
    adicionais: [{ codigo: 'LARGURA_ESTREITA', rotulo: 'Largura menor que 0,36 m', tipo: 'PCT', valor: 25, automatico: { larg_menor_que: 0.36 } }],
  },
};

const cat = criarCatalogo([...PRODUTOS_SEED, MAGIC, ROMANA, PH25]);
const base = { ladoComando: 'DIREITO' as const, sentidoEnrolamento: 'NORMAL' as const };

describe('linhas de persiana das tabelas de fornecedor', () => {
  it('Magic motorizada: exemplo da tabela (2,50 x 3,00) dá R$ 3.492,50 de custo, sem motor avulso', () => {
    const r = calcularPersiana({ ...base, sku: 'TST-MAGIC', medida: { tipo: 'PRODUCAO', largura: '2.50', altura: '3.00' }, acionamento: 'MOTORIZADO' }, cat);
    const magic = r.componentes.find((c) => c.sku === 'TST-MAGIC')!;
    expect(magic.custoTotal.toFixed(2)).toBe('3492.50');
    expect(magic.precoTotal.toFixed(2)).toBe('6985.00');
    expect(r.componentes.map((c) => c.sku)).not.toContain('MOT-001');
    expect(r.componentes.map((c) => c.sku)).not.toContain('MOT-002');
  });

  it('Magic manual: só o m² da tabela', () => {
    const r = calcularPersiana({ ...base, sku: 'TST-MAGIC', medida: { tipo: 'PRODUCAO', largura: '2.50', altura: '3.00' }, acionamento: 'MANUAL' }, cat);
    expect(r.componentes.find((c) => c.sku === 'TST-MAGIC')!.custoTotal.toFixed(2)).toBe('1815.00');
  });

  it('Romana cascata: +R$ 55/m² no custo e a venda segue o markup; degradê soma %', () => {
    const r = calcularPersiana({ ...base, sku: 'TST-ROM', medida: { tipo: 'PRODUCAO', largura: '1.00', altura: '2.00' }, acionamento: 'MANUAL', adicionais: ['CASCATA', 'DEGRADE'] }, cat);
    const c = r.componentes.find((x) => x.sku === 'TST-ROM')!;
    // 2 m² x (155,15 x 1,10 + 55) = 451,33 ; venda 2 x (310,30 x 1,10 + 110) = 902,66
    expect(c.custoTotal.toFixed(2)).toBe('451.33');
    expect(c.precoTotal.toFixed(2)).toBe('902.66');
    expect(c.formulaLog).toMatch(/Romana cascata/);
    expect(descricaoComercial({ tipo: 'PERSIANA', entrada: { ...base, sku: 'TST-ROM', medida: { tipo: 'PRODUCAO', largura: '1.00', altura: '2.00' }, acionamento: 'MANUAL', adicionais: ['CASCATA', 'DEGRADE'] } }, cat))
      .toBe('Romana Almansa Translúcido, cascata (1,00 m x 2,00 m)');
  });

  it('acima do recomendado vira sob consulta; acima do sob consulta é crítico; cascata baixa a altura máxima', () => {
    const alertas = (l: string, h: string, ad: string[] = []) => calcularPersiana({ ...base, sku: 'TST-ROM', medida: { tipo: 'PRODUCAO', largura: l, altura: h }, acionamento: 'MANUAL', adicionais: ad }, cat).alertas;
    expect(alertas('0.80', '3.50').map((a) => a.codigo)).toEqual([]);
    expect(alertas('0.80', '3.50', ['CASCATA']).map((a) => a.codigo)).toContain('SOB_CONSULTA');
    const consulta = alertas('3.50', '1.00');
    expect(consulta.find((a) => a.codigo === 'SOB_CONSULTA')!.severidade).toBe('ATENCAO');
    expect(alertas('6.50', '1.00').find((a) => a.codigo === 'LARGURA_EXCEDE_ROLO')!.severidade).toBe('CRITICO');
    expect(alertas('2.00', '2.00').map((a) => a.codigo)).toContain('SUGERIR_ADICIONAL');
    expect(() => alertas('1.00', '1.00', ['NAO_EXISTE'])).toThrow(/não existe/);
  });

  it('PH: largura estreita soma 25% sozinha e abaixo da mínima produzida é crítico; sem alerta de telescopagem', () => {
    const r = calcularPersiana({ ...base, sku: 'TST-PH25', medida: { tipo: 'PRODUCAO', largura: '0.30', altura: '1.50' }, acionamento: 'MANUAL' }, cat);
    const c = r.componentes.find((x) => x.sku === 'TST-PH25')!;
    expect(c.custoTotal.toFixed(2)).toBe('120.38'); // 1,00 m² mínimo x 96,30 x 1,25
    expect(r.alertas.map((a) => a.codigo)).not.toContain('RISCO_TELESCOPAGEM');
    const r2 = calcularPersiana({ ...base, sku: 'TST-PH25', medida: { tipo: 'PRODUCAO', largura: '0.20', altura: '1.50' }, acionamento: 'MANUAL' }, cat);
    expect(r2.alertas.find((a) => a.codigo === 'LARGURA_ABAIXO_PRODUCAO')!.severidade).toBe('CRITICO');
  });

  it('modelo de acionamento fora da lista da linha dá erro', () => {
    expect(() => calcularPersiana({ ...base, sku: 'TST-MAGIC', medida: { tipo: 'PRODUCAO', largura: '1', altura: '1' }, acionamento: 'MANUAL', modeloAcionamento: 'SPT' }, cat)).toThrow(/SPT/);
  });

  it('quadro do vendedor mostra sob consulta, avisos e opcionais', () => {
    const r = regrasDoModelo({ tipo: 'PERSIANA', persiana: 'TST-ROM', acionamento: 'MANUAL' }, (s) => { try { return cat.obter(s); } catch { return undefined; } });
    const t = Object.fromEntries(r.map((x) => [x.titulo, x.texto]));
    expect(t['Largura máxima']).toMatch(/sob consulta/);
    expect(t['Área máxima']).toMatch(/4,00 m²/);
    expect(t['Opcionais']).toMatch(/Romana cascata \(\+R\$ 55,00 de custo por m²\)/);
    expect(r.map((x) => x.titulo)).not.toContain('Proporção');
  });
});

describe('item só de serviço', () => {
  it('soma os serviços escolhidos, sem medidas', () => {
    const r = calcularItem({ tipo: 'SERVICO', entrada: { servicos: [{ sku: 'SRV-002', quantidade: '3' }] } }, [], cat);
    const srv = PRODUTOS_SEED.find((p) => p.sku === 'SRV-002')!;
    expect(r.tipo).toBe('SERVICO');
    expect(r.vendaTotal.toFixed(2)).toBe((Number(srv.precoVendaUnitario) * 3).toFixed(2));
    expect(r.larguraProducao.toNumber()).toBe(0);
    expect(descricaoComercial({ tipo: 'SERVICO', entrada: { servicos: [{ sku: 'SRV-002', quantidade: '3' }] } }, cat)).toBe(`${srv.nome} (3)`);
    expect(descricaoComercial({ tipo: 'SERVICO', entrada: { servicos: [{ sku: 'SRV-002', quantidade: '1' }], descricao: 'Instalação das persianas do cliente' } }, cat)).toBe('Instalação das persianas do cliente');
  });

  it('sem serviço ou quantidade quebrada em peça dá erro', () => {
    expect(() => calcularItem({ tipo: 'SERVICO', entrada: { servicos: [] } }, [], cat)).toThrow(/pelo menos um/);
    expect(() => calcularItem({ tipo: 'SERVICO', entrada: { servicos: [{ sku: 'SRV-002', quantidade: '1.5' }] } }, [], cat)).toThrow(/inteira/);
  });
});

describe('cortina motorizada com trilho Slim', () => {
  const TRILHO: Produto = {
    sku: 'TST-SLIM', nome: 'Trilho Motorizado Slim Standard (Franzida) Branco', unidade: 'PC', custoUnitario: '670', precoVendaUnitario: '1340',
    metadata: { modelo: 'FRANZIDA', vias: 1, faixas: [{ ate: 1, custo: 670 }, { ate: 2.5, custo: 814 }, { ate: 12, custo: 1758 }] },
  };
  const c2 = criarCatalogo([...PRODUTOS_SEED, TRILHO]);
  const cortina = (largura: string, extra: Record<string, unknown> = {}) => calcularItem({ tipo: 'CORTINA', entrada: {
    larguraTrilho: largura, alturaPronta: '2.60', numFolhas: 2, confeccao: 'FRANZIDO', tecido: { sku: 'TEC-001' }, trilhoMotorizado: 'TST-SLIM', ...extra,
  } }, [], c2);

  it('troca trilho, deslizantes, terminais e garras pelo trilho motorizado na faixa da largura, com controle', () => {
    const r = cortina('2.40');
    const skus = r.componentes.map((c) => c.sku);
    expect(skus).toContain('TST-SLIM');
    expect(skus).not.toEqual(expect.arrayContaining(['TRI-002']));
    expect(skus.some((s) => /^(DES|FIX)-/.test(s))).toBe(false);
    const t = r.componentes.find((c) => c.sku === 'TST-SLIM')!;
    expect([t.custoTotal.toFixed(2), t.precoTotal.toFixed(2)]).toEqual(['814.00', '1628.00']);
    expect(skus).toContain('MOT-002');
    expect(cortina('2.40', { qtdControles: 0 }).componentes.map((c) => c.sku)).not.toContain('MOT-002');
  });

  it('acima de 12 m não fabrica; modelo errado para wave é crítico', () => {
    expect(() => cortina('12.50')).toThrow(/não produz/);
    const w = cortina('2.00', { confeccao: 'WAVE' });
    expect(w.alertas.find((a) => a.codigo === 'TRILHO_MOTORIZADO_MODELO')!.severidade).toBe('CRITICO');
  });
});

describe('bandô e sanefa vendidos à parte', () => {
  const SAN_AL: Produto = { sku: 'TST-SAN-AL', nome: 'Sanefa Alumínio', unidade: 'ML', custoUnitario: '34.50', precoVendaUnitario: '69.00' };
  const SAN_PVC: Produto = { sku: 'TST-SAN-PVC', nome: 'Sanefa PVC', unidade: 'ML', custoUnitario: '28.75', precoVendaUnitario: '57.50' };
  const VERT: Produto = { sku: 'TST-VERT', nome: 'Vertical Tecido Linen', unidade: 'M2', custoUnitario: '84.53', precoVendaUnitario: '169.06',
    metadata: { enrolavel: false, bandos: ['TST-SAN-AL', 'TST-SAN-PVC'], rotulo_bando: 'Sanefa' } };
  const BOX: Produto = { sku: 'TST-BOX', nome: 'Rolo Caixa Box 70 mm', unidade: 'M2', custoUnitario: '315.65', precoVendaUnitario: '631.30',
    metadata: { bando_incluso: true } };
  const c3 = criarCatalogo([...PRODUTOS_SEED, SAN_AL, SAN_PVC, VERT, BOX]);
  const vert = (extra: Record<string, unknown>) => calcularPersiana({ ...base, sku: 'TST-VERT', medida: { tipo: 'PRODUCAO', largura: '2.00', altura: '2.00' }, acionamento: 'MANUAL', ...extra }, c3);

  it('sem marcar não soma; marcando usa a 1ª sanefa ou a escolhida', () => {
    expect(vert({}).componentes.map((c) => c.sku).filter((s) => !s.startsWith('SRV'))).toEqual(['TST-VERT']);
    expect(vert({ possuiBando: true }).componentes.map((c) => c.sku)).toContain('TST-SAN-AL');
    const pvc = vert({ possuiBando: true, skuBando: 'TST-SAN-PVC' });
    expect(pvc.componentes.find((c) => c.sku === 'TST-SAN-PVC')!.custoTotal.toFixed(2)).toBe('57.50');
    expect(() => vert({ possuiBando: true, skuBando: 'ACP-001' })).toThrow(/não serve/);
    expect(descricaoComercial({ tipo: 'PERSIANA', entrada: { ...base, sku: 'TST-VERT', medida: { tipo: 'PRODUCAO', largura: '2.00', altura: '2.00' }, acionamento: 'MANUAL', possuiBando: true } }, c3))
      .toBe('Vertical Tecido Linen, c/ sanefa (2,00 m x 2,00 m)');
  });

  it('Caixa Box já vem com bandô: não soma avulso', () => {
    const r = calcularPersiana({ ...base, sku: 'TST-BOX', medida: { tipo: 'PRODUCAO', largura: '1.20', altura: '1.50' }, acionamento: 'MANUAL', possuiBando: true }, c3);
    expect(r.componentes.map((c) => c.sku).filter((s) => !s.startsWith('SRV'))).toEqual(['TST-BOX']);
    expect(r.alertas.map((a) => a.codigo)).toContain('BANDO_INCLUSO');
  });
});

describe('opcionais compatíveis com o acionamento e o modelo', () => {
  const ROLO: Produto = { sku: 'TST-ROLO', nome: 'Rolo Tohu', unidade: 'M2', custoUnitario: '142.31', precoVendaUnitario: '284.62',
    metadata: { acionamentos: ['D', 'E', 'SPT'], bandos: ['TST-BD-AL', 'TST-BD-MAG'],
      adicionais: [
        { codigo: 'COMANDO_ALIVIO', rotulo: 'Comando de alívio', tipo: 'CUSTO_PECA', valor: 70.62, apenas_manual: true, sugerir_area_acima: 6 },
        { codigo: 'SUPORTE_INTERMEDIARIO', rotulo: 'Suporte intermediário', tipo: 'CUSTO_PECA', valor: 26.75, apenas_modelos: ['SPT'] },
      ] } };
  const BD_AL: Produto = { sku: 'TST-BD-AL', nome: 'Bandô alumínio', unidade: 'ML', custoUnitario: '58.85', precoVendaUnitario: '117.70' };
  const BD_MAG: Produto = { sku: 'TST-BD-MAG', nome: 'Bandô Magnus', unidade: 'ML', custoUnitario: '214', precoVendaUnitario: '428', metadata: { somente_motorizado: true } };
  const c4 = criarCatalogo([...PRODUTOS_SEED, ROLO, BD_AL, BD_MAG]);
  const rolo = (extra: Record<string, unknown>) => calcularPersiana({ ...base, sku: 'TST-ROLO', medida: { tipo: 'PRODUCAO', largura: '1.50', altura: '1.50' }, acionamento: 'MANUAL', ...extra }, c4);

  it('lista só os opcionais que encaixam', () => {
    expect(adicionaisCompativeis(ROLO, { motorizado: false }).map((a) => a.codigo)).toEqual(['COMANDO_ALIVIO']);
    expect(adicionaisCompativeis(ROLO, { motorizado: true, modelo: 'SPT' }).map((a) => a.codigo)).toEqual(['SUPORTE_INTERMEDIARIO']);
    expect(bandosDoModelo(ROLO, { motorizado: false, obter: (s) => c4.obter(s) })).toEqual(['TST-BD-AL']);
    expect(bandosDoModelo(ROLO, { motorizado: true, obter: (s) => c4.obter(s) })).toEqual(['TST-BD-AL', 'TST-BD-MAG']);
  });

  it('recusa opcional ou bandô que não encaixa; 1,50 x 1,50 manual não tem alerta', () => {
    expect(() => rolo({ acionamento: 'MOTORIZADO', adicionais: ['COMANDO_ALIVIO'] })).toThrow(/só no acionamento manual/);
    expect(() => rolo({ adicionais: ['SUPORTE_INTERMEDIARIO'], modeloAcionamento: 'D' })).toThrow(/só no modelo SPT/);
    expect(() => rolo({ possuiBando: true, skuBando: 'TST-BD-MAG' })).toThrow(/só para persiana motorizada/);
    expect(rolo({}).alertas).toEqual([]);
  });
});
