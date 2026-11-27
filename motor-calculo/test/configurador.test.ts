import { describe, expect, it } from 'vitest';
import {
  calcularItem, catalogoSeed, checarLiberacao, d, descricaoComercial, garantiaDoItem, garantiaMesesProduto, ratearDesconto,
  sugerirControles, textoGarantia, totalizarOrcamento,
  type EntradaItem,
} from '../src/index.js';

const cortina: EntradaItem = {
  tipo: 'CORTINA',
  entrada: {
    larguraTrilho: '3.00', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
    tecido: { sku: 'TEC-001', fator: '2.5', margemBarra: '0.30' },
    forro: { sku: 'TEC-002', fator: '2.0', margemBarra: '0.20', desconto: '0.05' },
    skus: { trilho: 'TRI-002' },
  },
};
const persiana: EntradaItem = {
  tipo: 'PERSIANA',
  entrada: {
    sku: 'PER-001', medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.00' },
    acionamento: 'MOTORIZADO', ladoComando: 'DIREITO', sentidoEnrolamento: 'NORMAL', possuiBando: true,
  },
};

describe('calcularItem', () => {
  it('sem ajustes reproduz o caso 1 da especificação', () => {
    const r = calcularItem(cortina, [], catalogoSeed);
    expect(r.vendaTotal.toFixed(2)).toBe('2745.40');
    expect(r.custoTotal.toFixed(2)).toBe('1053.95');
    expect(r.componentes.every((c) => c.origem === 'MOTOR' && c.quantidadeOverride === null)).toBe(true);
    expect(r.larguraProducao.toFixed(2)).toBe('3.00');
  });

  it('aplica quantidade, remoção, inclusão e troca na ordem', () => {
    const r = calcularItem(cortina, [
      { tipo: 'QUANTIDADE', sku: 'FIX-002', quantidade: 9 },
      { tipo: 'REMOVER', sku: 'SRV-001' },
      { tipo: 'ADICIONAR', sku: 'FIX-003', quantidade: 1 },
      { tipo: 'SUBSTITUIR', sku: 'TEC-002', novoSku: 'TEC-003' },
    ], catalogoSeed);
    const por = Object.fromEntries(r.componentes.map((c) => [c.sku, c]));
    expect(por['FIX-002']!.quantidade.toString()).toBe('9');
    expect(por['FIX-002']!.quantidadeCalculada!.toString()).toBe('7');
    expect(por['FIX-002']!.precoTotal.toFixed(2)).toBe('58.50');
    expect(por['SRV-001']).toBeUndefined();
    expect(por['FIX-003']).toMatchObject({ origem: 'MANUAL', quantidadeCalculada: null });
    expect(por['TEC-002']).toBeUndefined();
    expect(por['TEC-003']!.quantidade.toString()).toBe('6');
    expect(por['TEC-003']!.precoTotal.toFixed(2)).toBe('750.00');
    // 2745.40 + 13 (2 garras) - 180 (instalação) + 18 (emenda) + 300 (125x6 - 75x6)
    expect(r.vendaTotal.toFixed(2)).toBe('2896.40');
  });

  it('recusa ajuste inválido', () => {
    expect(() => calcularItem(cortina, [{ tipo: 'QUANTIDADE', sku: 'DES-001', quantidade: '2.5' }], catalogoSeed)).toThrow(/inteira/);
    expect(() => calcularItem(cortina, [{ tipo: 'REMOVER', sku: 'NAO-EXISTE' }], catalogoSeed)).toThrow(/não está/);
    expect(() => calcularItem(cortina, [{ tipo: 'SUBSTITUIR', sku: 'TEC-001', novoSku: 'SRV-002' }], catalogoSeed)).toThrow(/unidade/);
    expect(() => calcularItem(cortina, [{ tipo: 'ADICIONAR', sku: 'TEC-001', quantidade: 1 }], catalogoSeed)).toThrow(/já está/);
  });

  it('persiana guarda a medida de produção', () => {
    const r = calcularItem(persiana, [], catalogoSeed);
    expect(r.vendaTotal.toFixed(2)).toBe('2316.60');
    expect(r.alturaProducao.toFixed(2)).toBe('1.00');
  });
});

describe('descricaoComercial', () => {
  it('monta o texto limpo do PDF', () => {
    expect(descricaoComercial(cortina, catalogoSeed)).toBe('Cortina Wave em Linho Sintetico Gaze c/ forro Forro Microfibra 80% (3,00 m x 2,60 m)');
    expect(descricaoComercial(persiana, catalogoSeed)).toBe('Persiana Rolo Tela Solar 3%, motorizada, c/ bandô (1,40 m x 1,00 m)');
  });
});

describe('totalizarOrcamento e trava de margem', () => {
  const itens = [{ vendaTotal: '2745.40', custoTotal: '1053.95' }, { vendaTotal: '2316.60', custoTotal: '964.60' }];

  it('sem desconto: margem líquida = bruta quando não há taxa nem comissão', () => {
    const t = totalizarOrcamento(itens, { descontoTipo: 'PERCENTUAL', descontoValor: 0 });
    expect(t.total.toFixed(2)).toBe('5062.00');
    expect(t.margemLiquidaPct.toFixed(2)).toBe('60.12');
    expect(t.semaforo).toBe('VERDE');
  });

  it('desconto %, taxa e comissão entram na margem líquida', () => {
    const t = totalizarOrcamento(itens, { descontoTipo: 'PERCENTUAL', descontoValor: 10 }, { taxaPagamentoPct: '3.5', comissaoPct: 5 });
    expect(t.descontoValor.toFixed(2)).toBe('506.20');
    expect(t.total.toFixed(2)).toBe('4555.80');
    expect(t.taxaPagamento.toFixed(2)).toBe('159.45');
    expect(t.comissao.toFixed(2)).toBe('227.79');
    // 4555.80 - 2018.55 - 159.45 - 227.79 = 2150.01
    expect(t.lucroLiquido.toFixed(2)).toBe('2150.01');
    expect(t.margemLiquidaPct.toFixed(2)).toBe('47.19');
  });

  it('desconto grande deixa vermelho e exige senha do ADMIN', () => {
    const t = totalizarOrcamento(itens, { descontoTipo: 'VALOR', descontoValor: '2000' });
    expect(t.semaforo).toBe('VERMELHO');
    expect(t.descontoPct.toFixed(2)).toBe('39.51');
    const c = checarLiberacao(t, '10');
    expect(c.exige).toBe(true);
    expect(c.motivos).toHaveLength(2);
  });

  it('desconto acima do limite do vendedor exige senha mesmo com margem verde', () => {
    const t = totalizarOrcamento(itens, { descontoTipo: 'PERCENTUAL', descontoValor: 12 });
    expect(t.semaforo).toBe('VERDE');
    expect(checarLiberacao(t, '10').motivos[0]).toMatch(/limite do vendedor/);
    expect(checarLiberacao(t, '15').exige).toBe(false);
  });

  it('recusa desconto maior que o total', () => {
    expect(() => totalizarOrcamento(itens, { descontoTipo: 'VALOR', descontoValor: 6000 })).toThrow(/maior/);
  });
});

describe('ratearDesconto', () => {
  it('rateia proporcional ao valor e manda a sobra de centavos ao maior', () => {
    const r = ratearDesconto([
      { id: 'a', vendaTotal: '100.00', componentes: [{ id: 'a1', precoTotal: '60.00' }, { id: 'a2', precoTotal: '40.00' }] },
      { id: 'b', vendaTotal: '200.00', componentes: [{ id: 'b1', precoTotal: '200.00' }] },
    ], '10.00');
    expect(r[0]!.descontoRateado.toFixed(2)).toBe('3.33');
    expect(r[1]!.descontoRateado.toFixed(2)).toBe('6.67');
    expect(r[0]!.componentes.map((c) => c.descontoRateado.toFixed(2))).toEqual(['2.00', '1.33']);
    const soma = r.reduce((s, i) => s.plus(i.descontoRateado), d(0));
    expect(soma.toFixed(2)).toBe('10.00');
    expect(r[1]!.componentes[0]!.precoTotalLiquido.toFixed(2)).toBe('193.33');
  });
});

describe('decisões do Gabriel (27/11/2026)', () => {
  it('fator padrão: wave 2,8, prega macho 3,0, franzido 2,5, forro 1,8', () => {
    const base = { larguraTrilho: '2.00', alturaPronta: '2.50', numFolhas: 2 as const, tecido: { sku: 'TEC-001' }, skus: { trilho: 'TRI-001' } };
    const fator = (confeccao: 'WAVE' | 'PREGA' | 'FRANZIDO') =>
      calcularItem({ tipo: 'CORTINA', entrada: { ...base, confeccao, forro: { sku: 'TEC-002' } } }, [], catalogoSeed).especificacaoTecnica as { tecido: { fator: string }; forro: { fator: string } };
    expect(fator('WAVE').tecido.fator).toBe('2.8');
    expect(fator('PREGA').tecido.fator).toBe('3');
    expect(fator('FRANZIDO').tecido.fator).toBe('2.5');
    expect(fator('FRANZIDO').forro.fator).toBe('1.8');
    const r = calcularItem({ tipo: 'CORTINA', entrada: { ...base, confeccao: 'FRANZIDO' } }, [], catalogoSeed);
    expect(r.componentes.some((c) => c.sku === 'DES-003')).toBe(false); // sem fita wave
    expect(r.componentes.some((c) => c.sku === 'DES-002')).toBe(true);
  });

  it('garantia: padrão 12 meses, rolo/double vision/painel 2 anos, motor 5 anos', () => {
    expect(garantiaMesesProduto({ nome: 'Linho Sintetico Gaze', metadata: {} })).toBe(12);
    expect(garantiaMesesProduto({ nome: 'Persiana Rolo Blackout 100%', metadata: {} })).toBe(24);
    expect(garantiaMesesProduto({ nome: 'Persiana Double Vision', metadata: {} })).toBe(24);
    expect(garantiaMesesProduto({ nome: 'Persiana Painel Japonês', metadata: {} })).toBe(24);
    expect(garantiaMesesProduto({ nome: 'Motor Tubular X', metadata: {} })).toBe(60);
    expect(garantiaMesesProduto({ nome: 'Qualquer', metadata: { garantia_meses: 36 } })).toBe(36);
    const g = garantiaDoItem(calcularItem(persiana, [], catalogoSeed).componentes.map((c) => c.sku), catalogoSeed);
    expect(g).toEqual({ meses: 24, motorMeses: 60 });
    expect(textoGarantia(g)).toBe('2 anos; motor 5 anos');
    expect(textoGarantia(garantiaDoItem(['TEC-001'], catalogoSeed))).toBe('12 meses');
  });

  it('controle: menor que cubra as peças (1, 6 ou 16 canais)', () => {
    const op = [{ sku: 'C1', canais: 1 }, { sku: 'C6', canais: 6 }, { sku: 'C16', canais: 16 }];
    expect(sugerirControles(1, op)).toEqual([{ sku: 'C1', canais: 1, quantidade: 1 }]);
    expect(sugerirControles(2, op)).toEqual([{ sku: 'C6', canais: 6, quantidade: 1 }]);
    expect(sugerirControles(7, op)).toEqual([{ sku: 'C16', canais: 16, quantidade: 1 }]);
    expect(sugerirControles(18, op)).toEqual([{ sku: 'C16', canais: 16, quantidade: 1 }, { sku: 'C6', canais: 6, quantidade: 1 }]);
    expect(sugerirControles(0, op)).toEqual([]);
  });
});
