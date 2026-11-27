/**
 * Mapeamento Drizzle das tabelas que a API já usa. A fonte da verdade do banco
 * são os arquivos SQL em db/migracoes/; o teste `schema.test.ts` garante que as
 * colunas daqui existem lá. Tabelas ainda sem uso na API não estão mapeadas.
 */
import {
  pgTable, pgEnum, uuid, varchar, text, boolean, timestamp, numeric, integer,
  serial, jsonb, date, char, primaryKey,
} from 'drizzle-orm/pg-core';

export const perfilUsuario = pgEnum('perfil_usuario_enum', ['ADMIN', 'VENDEDOR']);
export const unidadeMedida = pgEnum('unidade_medida_enum', ['M2', 'ML', 'UN', 'PC']);
export type Perfil = (typeof perfilUsuario.enumValues)[number];

export const lojas = pgTable('lojas', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: varchar('nome', { length: 120 }).notNull(),
  cnpj: varchar('cnpj', { length: 18 }),
  ativo: boolean('ativo').default(true),
});

export const parametrosSistema = pgTable('parametros_sistema', {
  id: serial('id').primaryKey(),
  lojaId: uuid('loja_id').notNull(),
  chave: varchar('chave', { length: 60 }).notNull(),
  valor: numeric('valor', { precision: 12, scale: 4 }).notNull(),
  vigenteDesde: date('vigente_desde').notNull(),
});

export const usuarios = pgTable('usuarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  lojaId: uuid('loja_id').notNull(),
  nome: varchar('nome', { length: 120 }).notNull(),
  email: varchar('email', { length: 150 }).notNull().unique(),
  senhaHash: text('senha_hash').notNull(),
  perfil: perfilUsuario('perfil').notNull(),
  comissaoPadrao: numeric('comissao_padrao', { precision: 5, scale: 2 }).default('0.00'),
  podeVerCustos: boolean('pode_ver_custos').default(false),
  descontoMaxPct: numeric('desconto_max_pct', { precision: 5, scale: 2 }).default('10.00'),
  ativo: boolean('ativo').default(true),
  criadoEm: timestamp('criado_em', { withTimezone: true }).defaultNow(),
  deveTrocarSenha: boolean('deve_trocar_senha').notNull().default(false),
  ultimoLoginEm: timestamp('ultimo_login_em', { withTimezone: true }),
});

export const sessoes = pgTable('sessoes', {
  id: char('id', { length: 64 }).primaryKey(),
  usuarioId: uuid('usuario_id').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  ultimoUsoEm: timestamp('ultimo_uso_em', { withTimezone: true }).notNull().defaultNow(),
  expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
  ip: varchar('ip', { length: 64 }),
  userAgent: varchar('user_agent', { length: 300 }),
});

export const categoriasProduto = pgTable('categorias_produto', {
  id: serial('id').primaryKey(),
  nome: varchar('nome', { length: 80 }).notNull(),
  tipoGrupo: varchar('tipo_grupo', { length: 30 }).notNull(),
  ordemExibicao: integer('ordem_exibicao').default(0),
});

export const produtos = pgTable('produtos', {
  id: uuid('id').primaryKey().defaultRandom(),
  sku: varchar('sku', { length: 30 }).notNull().unique(),
  categoriaId: integer('categoria_id').notNull(),
  fornecedorPadraoId: uuid('fornecedor_padrao_id'),
  nome: varchar('nome', { length: 160 }).notNull(),
  corColecao: varchar('cor_colecao', { length: 80 }),
  unidadeMedida: unidadeMedida('unidade_medida').notNull(),
  custoUnitario: numeric('custo_unitario', { precision: 12, scale: 4 }).notNull(),
  precoVendaUnitario: numeric('preco_venda_unitario', { precision: 12, scale: 4 }).notNull(),
  metadataTecnica: jsonb('metadata_tecnica').$type<Record<string, unknown>>().notNull().default({}),
  ativo: boolean('ativo').default(true),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).defaultNow(),
});

export const precosBarraTrilho = pgTable('precos_barra_trilho', {
  produtoId: uuid('produto_id').notNull(),
  tamanhoM: integer('tamanho_m').notNull(),
  custo: numeric('custo', { precision: 12, scale: 4 }).notNull(),
  venda: numeric('venda', { precision: 12, scale: 4 }).notNull(),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.produtoId, t.tamanhoM] })]);

export const tabelas = { lojas, parametrosSistema, usuarios, sessoes, categoriasProduto, produtos, precosBarraTrilho };
