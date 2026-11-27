import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { tabelas } from '../src/db/schema.js';
import { migrar } from '../src/db/migrar.js';
import { bancoLimpo } from './ajuda.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await bancoLimpo(); });
afterAll(async () => { await pool.end(); });

const contar = async (sql: string) => Number((await pool.query(sql)).rows[0].n);

describe('migrações e seed da especificação', () => {
  it('reaplicar não faz nada', async () => {
    expect(await migrar(pool)).toEqual([]);
  });

  it('carrega categorias, plano de contas, loja única e parâmetros', async () => {
    expect(await contar('SELECT COUNT(*) n FROM categorias_produto')).toBe(9);
    expect(await contar('SELECT COUNT(*) n FROM plano_contas')).toBe(20); // 16 da especificação + 4 do financeiro
    expect(await contar('SELECT COUNT(*) n FROM lojas')).toBe(1);
    const { rows } = await pool.query('SELECT chave, valor FROM parametros_sistema ORDER BY chave');
    expect(Object.fromEntries(rows.map((r) => [r.chave, r.valor]))).toEqual({
      ALERTA_LIMITE_MEI_PCT: '80.0000',
      ALIQUOTA_IMPOSTO_VENDA_PCT: '0.0000',
      GARANTIA_MESES: '12.0000',
      LIMITE_FATURAMENTO_ANUAL_MEI: '110000.0000',
      MARKUP_PADRAO_PCT: '100.0000',
      POS_VENDA_DIAS: '7.0000',
      PRAZO_ENTREGA_DIAS_UTEIS: '14.0000',
      SEMAFORO_AMARELO_MIN_PCT: '35.0000',
      SEMAFORO_VERDE_MIN_PCT: '45.0000',
      REPASSAR_TAXA_CARTAO: '1.0000',
      PARCELAS_SEM_JUROS: '3.0000',
      SINAL_PADRAO_PCT: '50.0000',
      VALIDADE_ORCAMENTO_DIAS: '15.0000',
    });
  });

  it('catálogo de exemplo tem os 32 SKUs (instalação de cortina em 2 faixas; controles de 1, 6 e 16 canais)', async () => {
    expect(await contar('SELECT COUNT(*) n FROM produtos')).toBe(32);
  });

  it('status de medição da v1.1: AGUARDANDO_MEDICAO (orçamento) e CONFERENCIA_MEDIDAS (pedido)', async () => {
    const valores = async (tipo: string) => (await pool.query(`SELECT unnest(enum_range(NULL::${tipo}))::text AS v`)).rows.map((r) => r.v);
    expect(await valores('status_orcamento_enum')).toContain('AGUARDANDO_MEDICAO');
    expect(await valores('status_pedido_enum')).toContain('CONFERENCIA_MEDIDAS');
    expect(await valores('status_pedido_enum')).not.toContain('AGUARDANDO_MEDICAO_FINAL');
  });

  it('perfil de usuário só aceita ADMIN e VENDEDOR', async () => {
    const { rows } = await pool.query(`SELECT unnest(enum_range(NULL::perfil_usuario_enum))::text AS p`);
    expect(rows.map((r) => r.p)).toEqual(['ADMIN', 'VENDEDOR']);
  });

  it('o mapeamento Drizzle bate com as colunas do banco', async () => {
    for (const t of Object.values(tabelas)) {
      const cfg = getTableConfig(t);
      const { rows } = await pool.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [cfg.name]);
      const noBanco = rows.map((r) => r.column_name).sort();
      expect(cfg.columns.map((c) => c.name).sort(), `tabela ${cfg.name}`).toEqual(noBanco);
    }
  });
});
