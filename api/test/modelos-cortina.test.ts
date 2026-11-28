import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';
import { montarProposta } from '../src/orcamentos/proposta.js';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, ana: string, cliente: string;

async function req(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

const modelo = {
  nome: 'Cortina Wave Linho + Forro',
  confeccao: 'WAVE',
  tecidoSku: 'TEC-001', secundarioSku: 'TEC-002', trilhoSku: 'TRI-002',
  acessorios: [
    { sku: 'DES-002', aplica: 'PRIMARIO', regra: 'DESLIZANTE' },
    { sku: 'DES-003', aplica: 'PRIMARIO', regra: 'ENTRETELA' },
    { sku: 'DES-002', aplica: 'SECUNDARIO', regra: 'DESLIZANTE' },
    { sku: 'FIX-001', aplica: 'CORTINA', regra: 'TERMINAL' },
    { sku: 'FIX-002', aplica: 'CORTINA', regra: 'GARRA' },
  ],
  maoObraSku: 'MDO-001',
};

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'ana@loja.com', perfil: 'VENDEDOR' });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  ana = await entrar(app, 'ana@loja.com');
  cliente = (await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'Cliente Modelo', telefoneWhatsapp: '11 97777-4321' })).json().cliente.id;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('modelos prontos de cortina', () => {
  it('só o ADMIN cadastra; o vendedor lista', async () => {
    expect((await req(ana, 'POST', '/api/catalogo/modelos-cortina', modelo)).statusCode).toBe(403);
    const r = await req(admin, 'POST', '/api/catalogo/modelos-cortina', modelo);
    expect(r.statusCode, r.body).toBe(201);
    const lista = (await req(ana, 'GET', '/api/catalogo/modelos-cortina')).json().modelos;
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ nome: modelo.nome, tecidoSku: 'TEC-001', secundarioSku: 'TEC-002', trilhoSku: 'TRI-002', maoObraSku: 'MDO-001' });
    expect(lista[0].acessorios).toHaveLength(5);
  });

  it('recusa SKU que não existe, nome repetido e entretela fora do wave', async () => {
    const r1 = await req(admin, 'POST', '/api/catalogo/modelos-cortina', { ...modelo, nome: 'Outro', trilhoSku: 'XYZ-999' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().erro).toContain('XYZ-999');
    expect((await req(admin, 'POST', '/api/catalogo/modelos-cortina', modelo)).statusCode).toBe(409);
    expect((await req(admin, 'POST', '/api/catalogo/modelos-cortina', { ...modelo, nome: 'Prega', confeccao: 'PREGA' })).statusCode).toBe(400);
  });

  it('orçamento com o modelo: usa os acessórios do modelo nas quantidades do Gabriel', async () => {
    const id = randomUUID();
    const r = await req(ana, 'PUT', `/api/orcamentos/${id}`, {
      clienteId: cliente,
      itens: [{ id: randomUUID(), ambiente: 'Sala', tipo: 'CORTINA', ajustes: [], entrada: {
        larguraTrilho: '2.50', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
        tecido: { sku: 'TEC-001' }, forro: { sku: 'TEC-002' }, skus: { trilho: 'TRI-002' },
        modelo: { nome: modelo.nome, acessorios: modelo.acessorios, maoObra: 'MDO-001' },
      } }],
    });
    expect(r.statusCode, r.body).toBe(200);
    const comps = r.json().orcamento.itens[0].componentes as { sku: string; quantidade: string }[];
    const q = (sku: string) => comps.filter((c) => c.sku === sku).map((c) => Number(c.quantidade));
    expect(q('DES-002')).toEqual([64, 32]);
    expect(q('DES-003')).toEqual([7]);
    expect(q('FIX-001')).toEqual([6]);
    expect(q('FIX-002')).toEqual([8]);
    expect(q('MDO-001')).toEqual([2.5]);
    expect(q('MDO-002')).toEqual([]);
    // Cortina não tem garantia: a proposta não fala em garantia.
    const p = (await montarProposta(app.db, id, false))!;
    expect(p.garantia).toBeNull();
    expect(p.ambientes[0]!.itens[0]!.garantia).toBe('');
  });

  it('orçamento novo, sem itens, não pede liberação de margem', async () => {
    const id = randomUUID();
    const r = await req(ana, 'PUT', `/api/orcamentos/${id}`, { clienteId: cliente, itens: [] });
    expect(r.statusCode, r.body).toBe(200);
    const o = r.json().orcamento;
    expect(o.liberacao.exige).toBe(false);
  });

  it('migração marcou "pode virar o tecido" nos tecidos que já existiam', async () => {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM produtos p JOIN categorias_produto c ON c.id = p.categoria_id
      WHERE c.perfil = 'TECIDO' AND COALESCE((p.metadata_tecnica->>'permite_corte_horizontal')::boolean, false) = false`);
    // O catálogo de exemplo dos testes já vem marcado; produção é marcada pela migração 0017.
    expect(rows[0].n).toBe(0);
  });

  it('tecido: largura do rolo no fim do nome e muda junto com a largura', async () => {
    await pool.query(`UPDATE produtos SET nome = 'Linho Teste 3,30 Médio', metadata_tecnica = metadata_tecnica - 'largura_rolo' WHERE sku = 'TEC-001'`);
    const n = async () => (await pool.query(`SELECT nome, metadata_tecnica->>'largura_rolo' AS l FROM produtos WHERE sku = 'TEC-001'`)).rows[0];
    expect(await n()).toEqual({ nome: 'Linho Teste Médio - 3,00 MT', l: '3.0' }); // sem largura: 3,00
    await pool.query(`UPDATE produtos SET metadata_tecnica = metadata_tecnica || '{"largura_rolo": 2.8}' WHERE sku = 'TEC-001'`);
    expect((await n()).nome).toBe('Linho Teste Médio - 2,80 MT');
  });

  it('exclui o modelo', async () => {
    const id = (await req(ana, 'GET', '/api/catalogo/modelos-cortina')).json().modelos[0].id;
    expect((await req(admin, 'DELETE', `/api/catalogo/modelos-cortina/${id}`)).statusCode).toBe(200);
    expect((await req(ana, 'GET', '/api/catalogo/modelos-cortina')).json().modelos).toHaveLength(0);
  });
});
