import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aplicarPrecosBarra,
  calcularCortina,
  CAMINHO_PRECOS_BARRA,
  carregarCatalogo,
  criarCatalogo,
  lerPrecosBarraCSV,
  normalizarNumero,
  PRODUTOS_SEED,
} from '../src/index.js';

const cab = 'sku;nome;tamanho_m;custo;venda';
const completa = (sku: string) =>
  [1, 2, 3, 4, 5, 6].map((t) => `${sku};x;${t};${t * 15},00;${t * 40},00`).join('\n');

describe('Planilha de preços por barra', () => {
  it('o modelo do repositório tem os 3 trilhos x 6 tamanhos, vazio', () => {
    const txt = readFileSync(CAMINHO_PRECOS_BARRA, 'utf-8');
    const linhas = txt.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(linhas[0]).toBe(cab);
    expect(linhas).toHaveLength(19);
    expect(lerPrecosBarraCSV(txt).linhas).toEqual([]);
  });

  it('com a planilha vazia, o caso 1 continua cobrando trilho por ML', () => {
    const { catalogo, skusComTabela, avisos } = carregarCatalogo();
    expect(skusComTabela).toEqual([]);
    expect(avisos).toEqual([]);
    const r = calcularCortina(
      { larguraTrilho: '3.00', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE', tecido: { sku: 'TEC-001', fator: '2.5' }, forro: { sku: 'TEC-002', fator: '2.0' } },
      catalogo,
    );
    expect(r.vendaTotalItem.toFixed(2)).toBe('2745.40');
  });

  it('aceita formato brasileiro (R$, milhar, vírgula decimal)', () => {
    expect(normalizarNumero('R$ 1.150,00')).toBe('1150.00');
    expect(normalizarNumero('55,5')).toBe('55.5');
    expect(normalizarNumero('55.50')).toBe('55.50');
  });

  it('SKU completo passa a cobrar por barra', () => {
    const { linhas } = lerPrecosBarraCSV(`${cab}\n${completa('TRI-002')}`);
    const r = aplicarPrecosBarra(PRODUTOS_SEED, linhas);
    expect(r.skusComTabela).toEqual(['TRI-002']);
    const cat = criarCatalogo(r.produtos);
    const c = calcularCortina(
      { larguraTrilho: '6.10', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE', tecido: { sku: 'TEC-001', fator: '2.5' } },
      cat,
    );
    const trilho = c.componentes.filter((x) => x.sku === 'TRI-002').map((x) => [x.descricao, x.quantidade.toString(), x.precoTotal.toFixed(2)]);
    expect(trilho).toEqual([
      ['Trilho Suico Duplo Largo - barra 6 m', '1', '240.00'],
      ['Trilho Suico Duplo Largo - barra 1 m', '1', '40.00'],
    ]);
  });

  it('SKU parcial continua por ML e avisa quais tamanhos faltam', () => {
    const { linhas, avisos } = lerPrecosBarraCSV(`${cab}\nTRI-001;x;1;20;55\nTRI-001;x;2;36;\nTRI-001;x;3;;`);
    expect(avisos).toEqual(['Linha 3 (TRI-001, 2 m): preencha custo e venda; linha ignorada.']);
    const r = aplicarPrecosBarra(PRODUTOS_SEED, linhas);
    expect(r.skusComTabela).toEqual([]);
    expect(r.avisos).toEqual(['SKU TRI-001: faltam preços das barras de 2, 3, 4, 5, 6 m; continua cobrado por ML.']);
  });

  it('avisa SKU que não existe no catálogo e número inválido', () => {
    const { linhas, avisos } = lerPrecosBarraCSV(`${cab}\nTRI-999;x;1;20;55\nTRI-001;x;1;abc;55`);
    expect(avisos).toEqual(['Linha 3 (TRI-001): número inválido; linha ignorada.']);
    expect(aplicarPrecosBarra(PRODUTOS_SEED, linhas).avisos).toEqual(['SKU TRI-999 da planilha não existe no catálogo; ignorado.']);
  });
});
