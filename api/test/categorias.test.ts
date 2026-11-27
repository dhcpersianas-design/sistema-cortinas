import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { metadataDosCampos } from '@sistema/motor-calculo';
import { appTeste, bancoLimpo, criarUsuario, entrar, URL_TESTE } from './ajuda.js';
import { migrar, PASTA_MIGRACOES } from '../src/db/migrar.js';

/** Categorias em árvore e markup por categoria (Gabriel, 27/11/2026). */

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, vendedor: string;

const req = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, payload });
const produto = async (sku: string) => (await pool.query('SELECT * FROM produtos WHERE sku = $1', [sku])).rows[0];
const csv = (texto: string) => ({ arquivo: 'p.csv', conteudo: Buffer.from(texto, 'utf-8').toString('base64') });

describe('migração 0011: produtos atuais vão para as novas categorias sem perder dados', () => {
  it('SVK-002 (Horizontal), TEC10 (Vertical), sem tipo fica em Persianas, acabamentos em Peças e Acabamentos', async () => {
    const p = new pg.Pool({ connectionString: URL_TESTE });
    await p.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const pasta = mkdtempSync(join(tmpdir(), 'mig-'));
    try {
      for (const f of readdirSync(PASTA_MIGRACOES).filter((f) => f < '0011')) cpSync(join(PASTA_MIGRACOES, f), join(pasta, f));
      await migrar(p, pasta);
      await p.query(`INSERT INTO produtos (sku, categoria_id, nome, cor_colecao, unidade_medida, custo_unitario, preco_venda_unitario, metadata_tecnica) VALUES
        ('SVK-002', 6, 'Horizontal 25mm', 'Liso / Alumínio', 'M2', 92, 184, '{"larg_max": 2.5}'),
        ('TEC10',   6, 'Vertical', 'Nuance Translúcida', 'M2', 59, 118, '{}'),
        ('PX-1',    6, 'Persiana Especial', NULL, 'M2', 10, 20, '{}'),
        ('ACP-001', 7, 'Bandô', NULL, 'ML', 52, 135, '{"min_ml": 1}'),
        ('TEC-001', 1, 'Linho', NULL, 'ML', 42, 110, '{"largura_rolo": 3}')`);
      await p.query(`INSERT INTO parametros_sistema (loja_id, chave, valor, vigente_desde) VALUES ('00000000-0000-0000-0000-000000000001', 'MARKUP_PADRAO_PCT', 120, '2026-02-01')`);
      await migrar(p);
      const { rows } = await p.query(`SELECT p.sku, c.nome, p.custo_unitario, p.preco_venda_unitario, p.metadata_tecnica
        FROM produtos p JOIN categorias_produto c ON c.id = p.categoria_id ORDER BY p.sku`);
      expect(rows.map((r) => [r.sku, r.nome])).toEqual([
        ['ACP-001', 'Peças e Acabamentos'], ['PX-1', 'Persianas'], ['SVK-002', 'Horizontal'], ['TEC-001', 'Tecidos'], ['TEC10', 'Vertical'],
      ]);
      const svk = rows.find((r) => r.sku === 'SVK-002');
      expect([svk.custo_unitario, svk.preco_venda_unitario, svk.metadata_tecnica]).toEqual(['92.0000', '184.0000', { larg_max: 2.5 }]);
      // Markup das principais começa no markup padrão vigente.
      const m = await p.query(`SELECT nome, markup_pct FROM categorias_produto WHERE pai_id IS NULL ORDER BY ordem_exibicao`);
      expect(m.rows).toEqual([
        { nome: 'Persianas', markup_pct: '120.00' }, { nome: 'Tecidos', markup_pct: '120.00' }, { nome: 'Acessórios Persianas', markup_pct: '120.00' },
        { nome: 'Acessórios Cortinas', markup_pct: '120.00' }, { nome: 'Serviços', markup_pct: '120.00' },
      ]);
    } finally {
      rmSync(pasta, { recursive: true, force: true });
      await p.end();
    }
  });
});

describe('categorias e markup por categoria', () => {
  beforeAll(async () => {
    pool = await bancoLimpo();
    await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
    await criarUsuario(pool, { email: 'vendedor@loja.com', perfil: 'VENDEDOR' });
    app = await appTeste();
    admin = await entrar(app, 'admin@loja.com');
    vendedor = await entrar(app, 'vendedor@loja.com');
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  type Cat = { id: number; nome: string; paiId: number | null; caminho: string; perfil: string; markupEfetivo: string; temSubcategorias: boolean };
  const categorias = async (cookie = admin) => (await req(cookie, 'GET', '/api/catalogo/categorias')).json().categorias as Cat[];

  it('4 categorias principais + Serviços; Persianas com os tipos pedidos', async () => {
    const cats = await categorias();
    expect(cats.filter((c) => c.paiId === null).map((c) => c.nome)).toEqual(['Persianas', 'Tecidos', 'Acessórios Persianas', 'Acessórios Cortinas', 'Serviços']);
    expect(cats.filter((c) => c.paiId === 6).map((c) => c.nome)).toEqual(['Horizontal', 'Vertical', 'Painel', 'Romana', 'Rolo', 'Celular', 'Magic']);
    expect(cats.filter((c) => c.paiId === 24).map((c) => c.caminho)).toEqual([
      'Persianas › Rolo › Caixa Box', 'Persianas › Rolo › Double Vision', 'Persianas › Rolo › Rolo', 'Persianas › Rolo › Shangrilá',
    ]);
    expect(cats.find((c) => c.id === 2)).toMatchObject({ caminho: 'Acessórios Cortinas › Trilhos e Varões', perfil: 'TRILHO' });
    expect(cats.every((c) => c.markupEfetivo === '100')).toBe(true);
  });

  it('vendedor vê as categorias sem o markup', async () => {
    const cats = await categorias(vendedor);
    expect(cats[0]).not.toHaveProperty('markupEfetivo');
    expect((await req(vendedor, 'PATCH', '/api/catalogo/categorias/1', { markupPct: 10 })).statusCode).toBe(403);
  });

  it('lista de produtos traz caminho, categoria principal e perfil (o orçamento usa o perfil)', async () => {
    const lista = (await req(vendedor, 'GET', '/api/catalogo/produtos')).json().produtos as Record<string, unknown>[];
    expect(lista.find((p) => p.sku === 'PER-003')).toMatchObject({ categoria: 'Persianas › Rolo › Double Vision', categoriaPrincipal: 'Persianas', perfil: 'PERSIANA', faltaSubcategoria: false });
    expect(lista.find((p) => p.sku === 'TRI-001')).toMatchObject({ perfil: 'TRILHO', categoriaPrincipal: 'Acessórios Cortinas' });
  });

  it('markup da categoria vale no cadastro; subcategoria vazia herda; subcategoria pode ter o seu', async () => {
    expect((await req(admin, 'PATCH', '/api/catalogo/categorias/1', { markupPct: '150' })).statusCode).toBe(200);
    expect((await req(admin, 'PATCH', '/api/catalogo/categorias/6', { markupPct: '80,5' })).json().categoria.markupEfetivo).toBe('80.5');
    expect((await req(admin, 'PATCH', '/api/catalogo/categorias/28', { markupPct: 120 })).json().categoria.markupEfetivo).toBe('120');
    expect((await req(admin, 'PATCH', '/api/catalogo/categorias/6', { markupPct: null })).statusCode).toBe(400); // principal precisa

    const novo = async (sku: string, categoriaId: number) => {
      const r = await req(admin, 'POST', '/api/catalogo/produtos', { sku, categoriaId, nome: sku, unidadeMedida: 'M2', custoUnitario: '100' });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().precoVendaUnitario as string;
    };
    expect(await novo('TX-1', 1)).toBe('250.0000');   // Tecidos 150%
    expect(await novo('PH-1', 20)).toBe('180.5000');  // Horizontal herda Persianas 80,5%
    expect(await novo('PDV-1', 28)).toBe('220.0000'); // Double Vision 120%
    expect(await novo('SRV-X', 9)).toBe('200.0000');  // Serviços 100%
    expect((await req(admin, 'GET', '/api/catalogo/preco-sugerido?custo=10&categoriaId=1')).json()).toMatchObject({ markupPct: '150', precoVendaSugerido: '25.00' });
  });

  it('persiana exige subcategoria (e o tipo, dentro de Rolo)', async () => {
    for (const categoriaId of [6, 24]) {
      const r = await req(admin, 'POST', '/api/catalogo/produtos', { sku: `P-${categoriaId}`, categoriaId, nome: 'Persiana X', unidadeMedida: 'M2', custoUnitario: 1 });
      expect(r.statusCode).toBe(400);
      expect(r.json().erro).toContain('subcategoria');
    }
  });

  it('nova subcategoria herda o tipo de cadastro; nome repetido não pode', async () => {
    let r = await req(admin, 'POST', '/api/catalogo/categorias', { nome: 'Suportes', paiId: 7 });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as number;
    expect((await categorias()).find((c) => c.id === id)).toMatchObject({ caminho: 'Acessórios Persianas › Suportes', perfil: 'ACESSORIO_PERSIANA', markupEfetivo: '100' });
    r = await req(admin, 'POST', '/api/catalogo/categorias', { nome: 'suportes', paiId: 7 });
    expect(r.statusCode).toBe(409);
    r = await req(admin, 'POST', '/api/catalogo/categorias', { nome: 'Nível 4', paiId: 28 });
    expect(r.statusCode).toBe(400);
    expect((await req(admin, 'PATCH', '/api/catalogo/categorias/6', { nome: 'Outro' })).statusCode).toBe(400);
  });

  it('tabela de barras do trilho usa o markup de Acessórios Cortinas', async () => {
    await req(admin, 'PATCH', '/api/catalogo/categorias/10', { markupPct: 50 });
    const { id } = await produto('TRI-001');
    const r = await req(admin, 'PUT', `/api/catalogo/produtos/${id}/barras`, { barras: [{ tamanhoM: 1, custo: '10' }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().barras[0]).toMatchObject({ tamanhoM: 1, venda: '15.0000' });
  });

  it('importação: venda vazia e recálculo usam o markup da categoria; categoria pelo nome da subcategoria', async () => {
    const r = await req(admin, 'POST', '/api/catalogo/importacao/previa', csv([
      'SKU;Nome;Categoria;Unidade;Custo;Venda',
      'TEC-001;;;;50;',                                  // Tecidos 150% → 125
      'PDV-2;Double Vision Nova;Double Vision;M2;100;',  // 120% → 220
      'PR-2;Rolo Novo;Persianas > Rolo > Rolo;M2;100;',  // herda Persianas 80,5% → 180,50
      'PR-3;Rolo Só;Rolo;M2;100;',                       // "Rolo" = o tipo final
      'PP-1;Sem tipo;Persianas;M2;100;',                 // erro: falta subcategoria
    ].join('\n')));
    expect(r.statusCode, r.body).toBe(200);
    const itens = r.json().itens as { sku: string; acao: string; mudancas: string[]; erros: string[]; avisos: string[] }[];
    const it_ = (sku: string) => itens.find((i) => i.sku === sku)!;
    expect(it_('TEC-001').mudancas).toEqual(['Custo: R$ 42,00 → R$ 50,00', 'Venda: R$ 110,00 → R$ 125,00']);
    expect(it_('TEC-001').avisos.join()).toContain('markup da categoria, 150%');
    expect(it_('PDV-2').mudancas[0]).toContain('Persianas › Rolo › Double Vision');
    expect(it_('PDV-2').mudancas[0]).toContain('venda R$ 220,00');
    expect(it_('PR-2').mudancas[0]).toContain('venda R$ 180,50');
    expect(it_('PR-3').mudancas[0]).toContain('Persianas › Rolo › Rolo');
    expect(it_('PP-1').erros.join()).toContain('subcategoria');
  });
});

describe('campos do cadastro por tipo', () => {
  it('lê os campos do formulário para a metadata sem perder o que já existia', () => {
    const r = metadataDosCampos('TECIDO', { largura_rolo: '2,80', eh_forro: true, permite_corte_horizontal: false }, { outra: 'x', garantia_meses: 12 });
    expect(r).toEqual({ metadata: { outra: 'x', largura_rolo: 2.8, eh_forro: true, permite_corte_horizontal: false }, erros: [] });
    expect(metadataDosCampos('TECIDO', {}).erros).toEqual(['Preencha: Largura do rolo.']);
    expect(metadataDosCampos('TRILHO', { vias: '2', tipo: '' }, { tipo: 'VARAO' }).metadata).toEqual({ vias: 2 });
    expect(metadataDosCampos('MOTORIZACAO', { canais: '1,5' }).erros).toEqual(['Canais (só controle remoto): use número inteiro.']);
  });
});
