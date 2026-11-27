import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';
import { escreverXlsx, lerCsv, lerXlsx } from '../src/planilhas/xlsx.js';
import { lerValor } from '../src/catalogo/importacao.js';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, vendedor: string;

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'vendedor@loja.com', perfil: 'VENDEDOR', podeVerCustos: true });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  vendedor = await entrar(app, 'vendedor@loja.com');
});
afterAll(async () => { await app.close(); await pool.end(); });

const FIXTURE = new URL('./fixtures/precos-excel.xlsx', import.meta.url);
const corpo = (arquivo: string, buf: Buffer) => ({ arquivo, conteudo: buf.toString('base64') });
const post = (cookie: string, url: string, payload: object) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
const produto = async (sku: string) => (await pool.query('SELECT * FROM produtos WHERE sku = $1', [sku])).rows[0];

type Item = { aba: string; linha: number; sku: string; acao: string; erros: string[]; avisos: string[]; mudancas: string[]; tamanhoM: number | null };

describe('leitura de planilhas', () => {
  it('lê o .xlsx gravado por outro programa (textos compartilhados, números)', () => {
    const abas = lerXlsx(readFileSync(FIXTURE));
    expect(abas.map((a) => a.nome)).toEqual(['Produtos', 'Barras de trilho', 'Instruções']);
    expect(abas[0]!.linhas[0]!.map((c) => c.texto)).toEqual(['SKU', 'Nome', 'Categoria', 'Unidade', 'Cor/Coleção', 'Custo', 'Venda']);
    expect(abas[0]!.linhas[1]![5]).toEqual({ texto: '45.5', numero: true });
  });

  it('lê de volta a planilha que o próprio sistema gera', () => {
    const buf = escreverXlsx([{ nome: 'A', linhas: [['SKU', 'Custo'], ['X & <Y>', 12.3]] }]);
    const [a] = lerXlsx(buf);
    expect(a!.linhas[1]!.map((c) => c.texto)).toEqual(['X & <Y>', '12.3']);
  });

  it('CSV com ponto e vírgula, aspas e acentos', () => {
    const l = lerCsv('SKU;Nome;Custo\r\nTEC-1;"Linho; cru ""A""";1.150,00\n');
    expect(l[1]!.map((c) => c.texto)).toEqual(['TEC-1', 'Linho; cru "A"', '1.150,00']);
  });

  it('valores em reais', () => {
    expect(lerValor({ texto: 'R$ 1.150,00', numero: false })).toEqual({ valor: '1150.0000' });
    expect(lerValor({ texto: '79,9', numero: false })).toEqual({ valor: '79.9000' });
    expect(lerValor({ texto: '12.5', numero: false })).toEqual({ valor: '12.5000' });
    expect(lerValor({ texto: '0.3525', numero: true })).toEqual({ valor: '0.3525' });
    expect('erro' in lerValor({ texto: '1.150', numero: false })).toBe(true);
    expect('erro' in lerValor({ texto: '-5', numero: false })).toBe(true);
    expect('erro' in lerValor({ texto: 'abc', numero: false })).toBe(true);
  });
});

describe('importação de preços', () => {
  let importacaoId: string;

  it('vendedor não acessa', async () => {
    const r = await post(vendedor, '/api/catalogo/importacao/previa', corpo('p.xlsx', readFileSync(FIXTURE)));
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/catalogo/importacao/planilha', headers: { cookie: vendedor } })).statusCode).toBe(403);
  });

  it('prévia mostra o que muda e os erros, sem gravar nada', async () => {
    const r = await post(admin, '/api/catalogo/importacao/previa', corpo('precos.xlsx', readFileSync(FIXTURE)));
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json() as { itens: Item[]; resumo: Record<string, number> };
    const por = (aba: string, linha: number) => p.itens.find((i) => i.aba === aba && i.linha === linha)!;

    expect(por('Produtos', 2)).toMatchObject({ sku: 'TEC-001', acao: 'ATUALIZAR', mudancas: ['Custo: R$ 42,00 → R$ 45,50'] });
    expect(por('Produtos', 2).avisos.join()).toContain('venda atual foi mantida');
    expect(por('Produtos', 3)).toMatchObject({ sku: 'TEC-050', acao: 'CRIAR' });
    expect(por('Produtos', 4).mudancas).toEqual(['Custo: R$ 80,00 → R$ 90,00', 'Venda: R$ 180,00 → R$ 200,00']);
    expect(por('Produtos', 5)).toMatchObject({ sku: 'TRI-050', acao: 'CRIAR' });
    expect(por('Produtos', 5).avisos.join()).toContain('markup');
    expect(por('Produtos', 6).erros.join()).toContain('Categoria');
    expect(por('Produtos', 7).erros.join()).toContain('ambíguo');
    expect(por('Produtos', 8).erros.join()).toContain('repetido');
    expect(por('Produtos', 10).acao).toBe('SEM_MUDANCA');
    expect(por('Barras de trilho', 2)).toMatchObject({ sku: 'TRI-050', acao: 'CRIAR', tamanhoM: 1 });
    expect(por('Barras de trilho', 8)).toMatchObject({ sku: 'TRI-002', acao: 'CRIAR', tamanhoM: 6 });
    expect(por('Barras de trilho', 8).avisos.join()).toContain('1 de 6');
    expect(por('Barras de trilho', 9).erros.join()).toContain('Trilhos e Varões');
    expect(por('Barras de trilho', 10).erros.join()).toContain('Tamanho');
    expect(p.resumo).toEqual({ criar: 9, atualizar: 2, semMudanca: 1, ignoradas: 0, erros: 5 });

    expect((await produto('TEC-001')).custo_unitario).toBe('42.0000');
    expect(await produto('TEC-050')).toBeUndefined();
  });

  it('aplica só as linhas sem erro, com histórico', async () => {
    const r = await post(admin, '/api/catalogo/importacao/aplicar', corpo('precos.xlsx', readFileSync(FIXTURE)));
    expect(r.statusCode, r.body).toBe(201);
    importacaoId = r.json().importacaoId;

    const tec = await produto('TEC-001');
    expect([tec.custo_unitario, tec.preco_venda_unitario]).toEqual(['45.5000', '110.0000']);
    const novo = await produto('TEC-050');
    expect(novo).toMatchObject({ nome: 'Linho Rústico', categoria_id: 1, unidade_medida: 'ML', cor_colecao: 'Cru', custo_unitario: '30.0000', preco_venda_unitario: '79.9000' });
    expect((await produto('TRI-050')).preco_venda_unitario).toBe('40.0000');
    const barras = (await pool.query(`SELECT tamanho_m, custo, venda FROM precos_barra_trilho b JOIN produtos p ON p.id = b.produto_id WHERE p.sku = 'TRI-050' ORDER BY 1`)).rows;
    expect(barras).toHaveLength(6);
    expect(barras[5]).toEqual({ tamanho_m: 6, custo: '60.0000', venda: '120.0000' });
    expect((await produto('PER-001')).custo_unitario).toBe('135.0000'); // linha com erro ficou de fora

    const h = (await pool.query(`SELECT COUNT(*)::int n FROM historico_precos_produto WHERE importacao_id = $1`, [importacaoId])).rows[0];
    expect(h.n).toBe(11);
    const lista = (await app.inject({ method: 'GET', url: '/api/catalogo/importacoes', headers: { cookie: admin } })).json().importacoes;
    expect(lista[0]).toMatchObject({ id: importacaoId, arquivo: 'precos.xlsx', alteracoes: 11, desfeitaEm: null });
  });

  it('mandar a mesma planilha de novo não muda nada', async () => {
    const r = await post(admin, '/api/catalogo/importacao/aplicar', corpo('precos.xlsx', readFileSync(FIXTURE)));
    expect(r.statusCode).toBe(400);
    expect(r.json().erro).toContain('Nada para aplicar');
  });

  it('desfazer volta os preços, inativa o produto criado e mantém o que foi mexido depois', async () => {
    const tec2 = await produto('TRI-002');
    await pool.query(`UPDATE produtos SET preco_venda_unitario = 999 WHERE sku = 'SRV-001'`); // alguém mexeu depois
    const r = await post(admin, `/api/catalogo/importacoes/${importacaoId}/desfazer`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().mantidos).toEqual(['SRV-001 (alterado depois da importação)']);
    expect(r.json().restaurados).toBe(10);

    expect((await produto('TEC-001')).custo_unitario).toBe('42.0000');
    expect((await produto('TEC-050')).ativo).toBe(false);
    expect((await produto('SRV-001')).preco_venda_unitario).toBe('999.0000');
    const b = (await pool.query(`SELECT COUNT(*)::int n FROM precos_barra_trilho WHERE produto_id = $1`, [tec2.id])).rows[0];
    expect(b.n).toBe(0);

    const de2 = await post(admin, `/api/catalogo/importacoes/${importacaoId}/desfazer`, {});
    expect(de2.statusCode).toBe(409);
  });

  it('CSV do Excel em português (ponto e vírgula, Windows-1252)', async () => {
    const csv = Buffer.from('SKU;Nome;Custo;Preço de venda\r\nSRV-002;;65,00;150,00\r\n', 'latin1');
    const r = await post(admin, '/api/catalogo/importacao/previa', corpo('servicos.csv', csv));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().itens[0]).toMatchObject({ sku: 'SRV-002', acao: 'ATUALIZAR' });
  });

  it('código fixo que falta no catálogo pode ser criado só com o preço', async () => {
    await pool.query(`DELETE FROM produtos WHERE sku = 'SRV-006'`);
    const buf = escreverXlsx([{ nome: 'Produtos', linhas: [['SKU', 'Nome', 'Categoria', 'Unidade', 'Custo', 'Venda'], ['SRV-006', '', '', '', 70, 160], ['SRV-777', 'Sem preço', 'Servicos', 'UN', null, null]] }]);
    const r = await post(admin, '/api/catalogo/importacao/aplicar', corpo('srv.xlsx', buf));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().previa.itens[1].acao).toBe('IGNORADA');
    const p = await produto('SRV-006');
    expect(p).toMatchObject({ categoria_id: 9, unidade_medida: 'UN', preco_venda_unitario: '160.0000' });
    expect(p.metadata_tecnica).toMatchObject({ tipo: 'ADICIONAL' });
  });

  it('planilha para baixar traz o catálogo, os códigos fixos que faltam e as barras', async () => {
    await pool.query(`DELETE FROM produtos WHERE sku = 'SRV-003'`);
    const r = await app.inject({ method: 'GET', url: '/api/catalogo/importacao/planilha', headers: { cookie: admin } });
    expect(r.statusCode).toBe(200);
    const abas = lerXlsx(r.rawPayload);
    expect(abas.map((a) => a.nome)).toEqual(['Produtos', 'Barras de trilho', 'Instruções']);
    const skus = abas[0]!.linhas.map((l) => l[0]?.texto);
    expect(skus).toContain('TEC-001');
    const srv3 = abas[0]!.linhas.find((l) => l[0]?.texto === 'SRV-003')!;
    expect(srv3.map((c) => c?.texto ?? '')).toEqual(['SRV-003', 'Instalacao Persiana Motorizada', 'Servicos de Instalacao', 'PC']);
    expect(abas[1]!.linhas.filter((l) => l[0]?.texto === 'TRI-002')).toHaveLength(6);

    // A planilha baixada, enviada de volta sem mexer, não muda nada.
    const p = await post(admin, '/api/catalogo/importacao/previa', corpo('t.xlsx', r.rawPayload));
    expect(p.json().itens.filter((i: Item) => i.erros.length).map((i: Item) => `${i.aba}:${i.linha} ${i.erros}`)).toEqual([]);
    expect(p.json().resumo).toMatchObject({ criar: 0, atualizar: 0, erros: 0 });
  });

  it('arquivo errado dá mensagem clara', async () => {
    let r = await post(admin, '/api/catalogo/importacao/previa', corpo('a.xls', Buffer.from('x')));
    expect(r.json().erro).toContain('.xlsx');
    r = await post(admin, '/api/catalogo/importacao/previa', corpo('a.xlsx', Buffer.from('não é zip')));
    expect(r.json().erro).toContain('não é uma planilha');
    r = await post(admin, '/api/catalogo/importacao/previa', corpo('a.csv', Buffer.from('Nome;Custo\nX;1\n')));
    expect(r.json().erro).toContain('SKU');
  });
});
