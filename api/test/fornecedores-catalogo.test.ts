import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, vendedor: string, comCusto: string;

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'vendedor@loja.com', perfil: 'VENDEDOR' });
  await criarUsuario(pool, { email: 'gerente@loja.com', perfil: 'VENDEDOR', podeVerCustos: true });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  vendedor = await entrar(app, 'vendedor@loja.com');
  comCusto = await entrar(app, 'gerente@loja.com');
});
afterAll(async () => { await app.close(); await pool.end(); });

const req = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, payload });

describe('fornecedores (inclui instalador terceirizado sem login)', () => {
  let idInstalador: string;

  it('ADMIN cadastra instalador pessoa física com CPF, WhatsApp e PIX', async () => {
    const r = await req(admin, 'POST', '/api/fornecedores', {
      nomeFantasia: 'José Instalações', categoria: 'INSTALADOR', documento: '529.982.247-25',
      whatsapp: '(11) 97777-6666', chavePix: 'jose@pix.com', cidade: 'Osasco', uf: 'SP',
    });
    expect(r.statusCode).toBe(201);
    const f = r.json().fornecedor;
    idInstalador = f.id;
    expect(f.cnpj).toBe('52998224725');
    expect(f.whatsappLink).toBe('https://wa.me/5511977776666');
    expect(f.prazoEntregaDias).toBe(10);
  });

  it('categoria precisa ser válida', async () => {
    const r = await req(admin, 'POST', '/api/fornecedores', { nomeFantasia: 'X', categoria: 'PADARIA' });
    expect(r.statusCode).toBe(400);
  });

  it('busca sem acento e filtro por categoria', async () => {
    await req(admin, 'POST', '/api/fornecedores', { nomeFantasia: 'Tecidos Ômega', categoria: 'TECIDO', documento: '11.222.333/0001-81' });
    const porNome = (await req(admin, 'GET', '/api/fornecedores?q=omega')).json().fornecedores;
    expect(porNome.map((f: { nomeFantasia: string }) => f.nomeFantasia)).toEqual(['Tecidos Ômega']);
    const instaladores = (await req(admin, 'GET', '/api/fornecedores?categoria=INSTALADOR')).json().fornecedores;
    expect(instaladores.map((f: { id: string }) => f.id)).toEqual([idInstalador]);
    expect((await req(admin, 'GET', '/api/fornecedores?q=11222333')).json().fornecedores).toHaveLength(1);
  });

  it('edita e inativa', async () => {
    const r = await req(admin, 'PATCH', `/api/fornecedores/${idInstalador}`, { prazoEntregaDias: 3, chavePix: '' });
    expect(r.json().fornecedor).toMatchObject({ prazoEntregaDias: 3, chavePix: null, categoria: 'INSTALADOR' });
    await req(admin, 'PATCH', `/api/fornecedores/${idInstalador}`, { ativo: false });
    expect((await req(admin, 'GET', '/api/fornecedores?categoria=INSTALADOR')).json().fornecedores).toHaveLength(0);
    expect((await req(admin, 'GET', '/api/fornecedores?categoria=INSTALADOR&inativos=1')).json().fornecedores).toHaveLength(1);
  });

  it('vendedor não acessa fornecedores', async () => {
    expect((await req(vendedor, 'GET', '/api/fornecedores')).statusCode).toBe(403);
    expect((await req(comCusto, 'POST', '/api/fornecedores', { nomeFantasia: 'X', categoria: 'OUTRO' })).statusCode).toBe(403);
  });
});

describe('catálogo com histórico de preços', () => {
  let idProduto: string;
  let idTrilho: string;

  it('cadastro com venda em branco usa markup padrão de 100% (venda = 2x custo)', async () => {
    const r = await req(admin, 'POST', '/api/catalogo/produtos', {
      sku: 'tec-900', categoriaId: 1, nome: 'Linho Rústico', unidadeMedida: 'ML', custoUnitario: '42,50',
      metadataTecnica: { largura_rolo: 2.8 },
    });
    expect(r.statusCode).toBe(201);
    idProduto = r.json().id;
    expect(r.json().vendaSugerida).toBe(true);
    const p = (await req(admin, 'GET', `/api/catalogo/produtos/${idProduto}`)).json();
    expect(p.produto).toMatchObject({ sku: 'TEC-900', custoUnitario: '42.5000', precoVendaUnitario: '85.0000' });
    expect(p.historico).toHaveLength(1);
    expect(p.historico[0]).toMatchObject({ custoAnterior: null, custoNovo: '42.5000', vendaNova: '85.0000', alteradoPor: 'admin' });
  });

  it('SKU repetido: 409', async () => {
    const r = await req(admin, 'POST', '/api/catalogo/produtos', { sku: 'TEC-900', categoriaId: 1, nome: 'Outro', unidadeMedida: 'ML', custoUnitario: 1 });
    expect(r.statusCode).toBe(409);
  });

  it('preço sugerido segue o parâmetro MARKUP_PADRAO_PCT', async () => {
    expect((await req(admin, 'GET', '/api/catalogo/preco-sugerido?custo=1.150,00')).json().precoVendaSugerido).toBe('2300.00');
  });

  it('reajuste grava histórico; mudar só o nome não grava', async () => {
    let r = await req(admin, 'PATCH', `/api/catalogo/produtos/${idProduto}`, { custoUnitario: '45', precoVendaUnitario: '92.00', motivo: 'Reajuste fornecedor' });
    expect(r.json().historicoRegistrado).toBe(true);
    r = await req(admin, 'PATCH', `/api/catalogo/produtos/${idProduto}`, { nome: 'Linho Rústico Cru' });
    expect(r.json().historicoRegistrado).toBe(false);
    const p = (await req(admin, 'GET', `/api/catalogo/produtos/${idProduto}`)).json();
    expect(p.produto.metadata).toEqual({ largura_rolo: 2.8 }); // PATCH sem metadata não apaga
    expect(p.historico).toHaveLength(2);
    expect(p.historico[0]).toMatchObject({ custoAnterior: '42.5000', custoNovo: '45.0000', vendaAnterior: '85.0000', vendaNova: '92.0000', motivo: 'Reajuste fornecedor' });
  });

  it('vendedor vê o produto sem custo e sem histórico; não edita', async () => {
    const p = (await req(vendedor, 'GET', `/api/catalogo/produtos/${idProduto}`)).json();
    expect(p.produto.custoUnitario).toBeUndefined();
    expect(p.produto.fornecedorPadraoId).toBeUndefined();
    expect(p.historico).toBeUndefined();
    expect(p.produto.precoVendaUnitario).toBe('92.0000');
    expect((await req(vendedor, 'PATCH', `/api/catalogo/produtos/${idProduto}`, { nome: 'X' })).statusCode).toBe(403);
    const c = (await req(comCusto, 'GET', `/api/catalogo/produtos/${idProduto}`)).json();
    expect(c.produto.custoUnitario).toBe('45.0000');
  });

  it('busca no catálogo sem acento', async () => {
    const lista = (await req(vendedor, 'GET', '/api/catalogo/produtos?q=rustico')).json().produtos;
    expect(lista.map((p: { sku: string }) => p.sku)).toEqual(['TEC-900']);
  });

  it('tabela de barras do trilho: preenche, sugere venda, grava histórico por tamanho', async () => {
    const lista = (await req(admin, 'GET', '/api/catalogo/produtos?q=TRI-002')).json().produtos;
    idTrilho = lista[0].id;
    let r = await req(admin, 'PUT', `/api/catalogo/produtos/${idTrilho}/barras`, {
      barras: [{ tamanhoM: 1, custo: '40', venda: '95' }, { tamanhoM: 2, custo: '70' }],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().barras).toEqual([
      { tamanhoM: 1, custo: '40.0000', venda: '95.0000' },
      { tamanhoM: 2, custo: '70.0000', venda: '140.0000' },
    ]);
    expect(r.json().tabelaBarrasCompleta).toBe(false);
    expect(r.json().avisos[0]).toMatch(/Faltam 4/);

    r = await req(admin, 'PUT', `/api/catalogo/produtos/${idTrilho}/barras`, {
      barras: [1, 2, 3, 4, 5, 6].map((t) => ({ tamanhoM: t, custo: String(30 * t + 10), venda: String(80 * t) })),
      motivo: 'Tabela 2027',
    });
    expect(r.json().tabelaBarrasCompleta).toBe(true);
    expect(r.json().alteracoes).toBe(6);
    // Reenviar igual não gera histórico
    r = await req(admin, 'PUT', `/api/catalogo/produtos/${idTrilho}/barras`, {
      barras: [1, 2, 3, 4, 5, 6].map((t) => ({ tamanhoM: t, custo: String(30 * t + 10), venda: String(80 * t) })),
    });
    expect(r.json().alteracoes).toBe(0);
    const h = (await req(admin, 'GET', `/api/catalogo/produtos/${idTrilho}`)).json().historico;
    expect(h.filter((x: { tamanhoM: number }) => x.tamanhoM === 2)).toHaveLength(2);
  });

  it('o cálculo passa a cobrar o trilho por barra', async () => {
    const r = (await req(admin, 'POST', '/api/calculo/cortina', {
      larguraTrilho: '3.00', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
      tecido: { sku: 'TEC-001', fator: '2.5', margemBarra: '0.30' }, skus: { trilho: 'TRI-002' },
    })).json();
    const trilho = r.componentes.find((c: { sku: string }) => c.sku === 'TRI-002');
    expect(trilho.precoTotal).toBe('240.00'); // barra de 3 m = 80 x 3
  });

  it('vendedor vê a tabela de barras só com venda', async () => {
    const lista = (await req(vendedor, 'GET', '/api/catalogo/produtos?q=TRI-002')).json().produtos;
    expect(lista[0].barras[0]).toEqual({ tamanhoM: 1, venda: '80.0000' });
    expect((await req(vendedor, 'PUT', `/api/catalogo/produtos/${idTrilho}/barras`, { barras: [] })).statusCode).toBe(403);
  });

  it('remove um tamanho e recusa tabela em produto que não é trilho', async () => {
    const r = await req(admin, 'PUT', `/api/catalogo/produtos/${idTrilho}/barras`, { barras: [{ tamanhoM: 6, custo: null, venda: null }] });
    expect(r.json().barras).toHaveLength(5);
    const outro = await req(admin, 'PUT', `/api/catalogo/produtos/${idProduto}/barras`, { barras: [{ tamanhoM: 1, custo: '1' }] });
    expect(outro.statusCode).toBe(400);
    const semCusto = await req(admin, 'PUT', `/api/catalogo/produtos/${idTrilho}/barras`, { barras: [{ tamanhoM: 6, venda: '10' }] });
    expect(semCusto.statusCode).toBe(400);
  });

  it('inativar esconde do vendedor, ADMIN vê com inativos=1', async () => {
    await req(admin, 'PATCH', `/api/catalogo/produtos/${idProduto}`, { ativo: false });
    expect((await req(vendedor, 'GET', '/api/catalogo/produtos?q=rustico&inativos=1')).json().produtos).toHaveLength(0);
    expect((await req(admin, 'GET', '/api/catalogo/produtos?q=rustico&inativos=1')).json().produtos).toHaveLength(1);
  });

  it('fornecedor padrão do produto', async () => {
    const f = (await req(admin, 'POST', '/api/fornecedores', { nomeFantasia: 'Trilhos Sul', categoria: 'FERRAGEM' })).json().fornecedor;
    await req(admin, 'PATCH', `/api/catalogo/produtos/${idTrilho}`, { fornecedorPadraoId: f.id });
    const ficha = (await req(admin, 'GET', `/api/fornecedores/${f.id}`)).json();
    expect(ficha.produtos.map((p: { sku: string }) => p.sku)).toEqual(['TRI-002']);
  });
});
