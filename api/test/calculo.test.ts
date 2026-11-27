import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';

let pool: pg.Pool;
let app: FastifyInstance;

const caso1 = {
  larguraTrilho: '3.00', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
  tecido: { sku: 'TEC-001', fator: '2.5', margemBarra: '0.30' },
  forro: { sku: 'TEC-002', fator: '2.0', margemBarra: '0.20', desconto: '0.05' },
  skus: { trilho: 'TRI-002' },
};
const caso2 = {
  sku: 'PER-001', medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.00' },
  acionamento: 'MOTORIZADO', ladoComando: 'DIREITO', sentidoEnrolamento: 'NORMAL', possuiBando: true,
};

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'vendedor@loja.com', perfil: 'VENDEDOR' });
  await criarUsuario(pool, { email: 'gerente@loja.com', perfil: 'VENDEDOR', podeVerCustos: true });
  app = await appTeste();
});
afterAll(async () => { await app.close(); await pool.end(); });

const post = async (cookie: string, url: string, payload: object) => app.inject({ method: 'POST', url, headers: { cookie }, payload });

describe('motor de cálculo com o catálogo do banco', () => {
  it('Caso 1 da especificação: R$ 2.745,40 e margem 61,61%', async () => {
    const r = (await post(await entrar(app, 'admin@loja.com'), '/api/calculo/cortina', caso1)).json();
    expect(r.vendaTotalItem).toBe('2745.40');
    expect(r.custoTotalItem).toBe('1053.95');
    expect(r.margemBrutaPct).toBe('61.61');
    expect(r.semaforo).toBe('VERDE');
    expect(r.componentes).toHaveLength(11);
  });

  it('Caso 2 da especificação: R$ 2.316,60 e margem 58,36%', async () => {
    const r = (await post(await entrar(app, 'admin@loja.com'), '/api/calculo/persiana', caso2)).json();
    expect(r.vendaTotalItem).toBe('2316.60');
    expect(r.margemBrutaPct).toBe('58.36');
  });

  it('vendedor sem pode_ver_custos não recebe custo, lucro nem margem; só o semáforo', async () => {
    const r = (await post(await entrar(app, 'vendedor@loja.com'), '/api/calculo/cortina', caso1)).json();
    expect(r.vendaTotalItem).toBe('2745.40');
    expect(r.semaforo).toBe('VERDE');
    const texto = JSON.stringify(r);
    for (const campo of ['custoTotalItem', 'lucroBrutoItem', 'margemBrutaPct', 'custoUnitario', 'custoTotal']) {
      expect(texto).not.toContain(`"${campo}"`);
    }
  });

  it('vendedor com pode_ver_custos vê a margem', async () => {
    const r = (await post(await entrar(app, 'gerente@loja.com'), '/api/calculo/cortina', caso1)).json();
    expect(r.margemBrutaPct).toBe('61.61');
  });

  it('cortina acima de 3,00 m usa a instalação SRV-004 do catálogo do banco (2x)', async () => {
    const r = (await post(await entrar(app, 'admin@loja.com'), '/api/calculo/cortina', { ...caso1, larguraTrilho: '4.20' })).json();
    const skus = r.componentes.map((c: { sku: string }) => c.sku);
    expect(skus).toContain('SRV-004');
    expect(skus).not.toContain('SRV-001');
    expect(r.componentes.find((c: { sku: string }) => c.sku === 'SRV-004').precoTotal).toBe('360.00');
  });

  it('entrada inválida volta 400 com a mensagem do motor', async () => {
    const r = await post(await entrar(app, 'admin@loja.com'), '/api/calculo/cortina', { ...caso1, larguraTrilho: '-1' });
    expect(r.statusCode).toBe(400);
    expect(r.json().erro).toBeTruthy();
  });

  it('com a tabela de barras completa no banco, o trilho passa a ser cobrado por barra', async () => {
    await pool.query(`INSERT INTO precos_barra_trilho (produto_id, tamanho_m, custo, venda)
      SELECT id, t, t * 30, t * 80 FROM produtos, generate_series(1, 6) t WHERE sku = 'TRI-002'`);
    const r = (await post(await entrar(app, 'admin@loja.com'), '/api/calculo/cortina', caso1)).json();
    const trilho = r.componentes.filter((c: { sku: string }) => c.sku === 'TRI-002');
    expect(trilho).toHaveLength(1);
    expect(trilho[0]).toMatchObject({ precoTotal: '240.00', custoTotal: '90.00' });
    await pool.query('DELETE FROM precos_barra_trilho');
  });
});

describe('catálogo', () => {
  it('vendedor vê preço de venda, sem custo', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/catalogo/produtos', headers: { cookie: await entrar(app, 'vendedor@loja.com') } })).json();
    expect(r.produtos).toHaveLength(32);
    expect(r.produtos[0]).toHaveProperty('precoVendaUnitario');
    expect(r.produtos[0]).not.toHaveProperty('custoUnitario');
  });

  it('admin vê custo', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/catalogo/produtos', headers: { cookie: await entrar(app, 'admin@loja.com') } })).json();
    expect(r.produtos[0]).toHaveProperty('custoUnitario');
  });
});
