import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';
import { gerarPdf, montarProposta } from '../src/orcamentos/proposta.js';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, ana: string, cliente: string;

async function req(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'ana@loja.com', perfil: 'VENDEDOR' });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  ana = await entrar(app, 'ana@loja.com');
  cliente = (await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'Cliente Serviço', telefoneWhatsapp: '11 97777-1234' })).json().cliente.id;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('orçamento só de serviço', () => {
  it('item de serviço sem produto: soma o serviço, sem medidas, e sai no PDF', async () => {
    const id = randomUUID();
    const r = await req(ana, 'PUT', `/api/orcamentos/${id}`, {
      clienteId: cliente,
      itens: [{ id: randomUUID(), ambiente: 'Sala', tipo: 'SERVICO', ajustes: [],
        entrada: { servicos: [{ sku: 'SRV-002', quantidade: '2' }], descricao: 'Reinstalação de 2 persianas do cliente' } }],
    });
    expect(r.statusCode, r.body).toBe(200);
    const o = r.json().orcamento;
    expect(o.itens[0].tipo).toBe('SERVICO');
    expect(o.itens[0].descricaoComercial).toBe('Reinstalação de 2 persianas do cliente');
    expect(o.itens[0].componentes.map((c: { sku: string }) => c.sku)).toEqual(['SRV-002']);
    expect(Number(o.totais.total)).toBeGreaterThan(0);
    const dados = await montarProposta(app.db, id, false);
    const item = dados!.ambientes[0]!.itens[0]!;
    expect(item.icone).toBe('SERVICO');
    expect(item.medidas).toBe('');
    expect(item.pecas).toBe(0);
    expect((await gerarPdf(dados!)).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('serviço sem nenhuma linha é recusado', async () => {
    const r = await req(ana, 'PUT', `/api/orcamentos/${randomUUID()}`, {
      clienteId: cliente, itens: [{ id: randomUUID(), ambiente: 'Sala', tipo: 'SERVICO', ajustes: [], entrada: { servicos: [] } }],
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('excluir produto', () => {
  it('só o ADMIN exclui; produto usado em orçamento não pode ser excluído', async () => {
    const novo = await req(admin, 'POST', '/api/catalogo/produtos', {
      sku: 'APAGAR-1', categoriaId: 3, nome: 'Produto de teste', unidadeMedida: 'UN', custoUnitario: '1.00',
    });
    expect(novo.statusCode, novo.body).toBe(201);
    const idNovo = novo.json().id;
    expect((await req(ana, 'DELETE', `/api/catalogo/produtos/${idNovo}`)).statusCode).toBe(403);
    const ok = await req(admin, 'DELETE', `/api/catalogo/produtos/${idNovo}`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await pool.query(`SELECT 1 FROM produtos WHERE sku = 'APAGAR-1'`)).rowCount).toBe(0);

    const usado = (await pool.query(`SELECT id FROM produtos WHERE sku = 'SRV-002'`)).rows[0].id;
    const r = await req(admin, 'DELETE', `/api/catalogo/produtos/${usado}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().erro).toMatch(/não pode ser excluído/);
    expect((await req(admin, 'DELETE', `/api/catalogo/produtos/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('mensagem do WhatsApp', () => {
  it('texto de envio para conferência, sem valores e sem link', async () => {
    const { mensagemProposta } = await import('../src/rotas/orcamentos.js');
    const m = mensagemProposta({ cliente: 'Gabrielly Souza', vendedor: 'Gabriel Lima', loja: 'DHC Persianas & Cortinas', codigo: 'ORC-2026-0002', versao: 1 });
    expect(m).toMatch(/^Olá, Gabrielly! Tudo bem\?/);
    expect(m).toContain('Aqui é Gabriel da DHC Persianas & Cortinas.');
    expect(m).toContain('proposta ORC-2026-0002');
    expect(m).toMatch(/conferência/);
    expect(m).not.toMatch(/R\$|http|www\./);
  });
});
