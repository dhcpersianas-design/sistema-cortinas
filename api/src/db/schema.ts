/**
 * Mapeamento Drizzle das tabelas que a API já usa. A fonte da verdade do banco
 * são os arquivos SQL em db/migracoes/; o teste `schema.test.ts` garante que as
 * colunas daqui existem lá. Tabelas ainda sem uso na API não estão mapeadas.
 */
import {
  pgTable, pgEnum, uuid, varchar, text, boolean, timestamp, numeric, integer,
  serial, jsonb, date, char, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const perfilUsuario = pgEnum('perfil_usuario_enum', ['ADMIN', 'VENDEDOR']);
export const unidadeMedida = pgEnum('unidade_medida_enum', ['M2', 'ML', 'UN', 'PC']);
export type Perfil = (typeof perfilUsuario.enumValues)[number];

export const lojas = pgTable('lojas', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: varchar('nome', { length: 120 }).notNull(),
  cnpj: varchar('cnpj', { length: 18 }),
  telefone: varchar('telefone', { length: 20 }),
  email: varchar('email', { length: 120 }),
  instagram: varchar('instagram', { length: 60 }),
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
  nomeBusca: text('nome_busca').generatedAlwaysAs(sql`f_busca(sku || ' ' || nome || ' ' || COALESCE(cor_colecao, ''))`),
});

export const historicoPrecosProduto = pgTable('historico_precos_produto', {
  id: uuid('id').primaryKey().defaultRandom(),
  produtoId: uuid('produto_id').notNull(),
  custoAnterior: numeric('custo_anterior', { precision: 12, scale: 4 }),
  custoNovo: numeric('custo_novo', { precision: 12, scale: 4 }),
  vendaAnterior: numeric('venda_anterior', { precision: 12, scale: 4 }),
  vendaNova: numeric('venda_nova', { precision: 12, scale: 4 }),
  alteradoPor: uuid('alterado_por'),
  alteradoEm: timestamp('alterado_em', { withTimezone: true }).defaultNow(),
  tamanhoM: integer('tamanho_m'),
  motivo: varchar('motivo', { length: 200 }),
});

export const tipoPessoa = pgEnum('tipo_pessoa_enum', ['PF', 'PJ']);

export const clientes = pgTable('clientes', {
  id: uuid('id').primaryKey().defaultRandom(),
  lojaId: uuid('loja_id').notNull(),
  nomeCompleto: varchar('nome_completo', { length: 150 }).notNull(),
  tipoPessoa: tipoPessoa('tipo_pessoa').default('PF'),
  cpfCnpj: varchar('cpf_cnpj', { length: 18 }).unique(),
  telefoneWhatsapp: varchar('telefone_whatsapp', { length: 20 }).notNull(),
  telefoneSecundario: varchar('telefone_secundario', { length: 20 }),
  email: varchar('email', { length: 150 }),
  origemLead: varchar('origem_lead', { length: 60 }),
  cep: varchar('cep', { length: 10 }),
  logradouro: varchar('logradouro', { length: 160 }),
  numero: varchar('numero', { length: 20 }),
  complemento: varchar('complemento', { length: 100 }),
  bairro: varchar('bairro', { length: 100 }),
  cidade: varchar('cidade', { length: 100 }),
  uf: char('uf', { length: 2 }),
  tipoImovel: varchar('tipo_imovel', { length: 30 }),
  obsAcessoInstalacao: text('obs_acesso_instalacao'),
  dataRegistro: timestamp('data_registro', { withTimezone: true }).defaultNow(),
  ultimaCompraEm: timestamp('ultima_compra_em', { withTimezone: true }),
  ultimaInstalacaoEm: timestamp('ultima_instalacao_em', { withTimezone: true }),
  ativo: boolean('ativo').default(true),
  vendedorResponsavelId: uuid('vendedor_responsavel_id'),
  criadoPorId: uuid('criado_por_id'),
  observacoes: text('observacoes'),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  nomeBusca: text('nome_busca').generatedAlwaysAs(sql`f_busca(nome_completo)`),
});

export const CATEGORIAS_FORNECEDOR = ['TECIDO', 'PERSIANA', 'FERRAGEM', 'MOTORIZACAO', 'COSTUREIRA', 'INSTALADOR', 'OUTRO'] as const;

export const fornecedores = pgTable('fornecedores', {
  id: uuid('id').primaryKey().defaultRandom(),
  nomeFantasia: varchar('nome_fantasia', { length: 140 }).notNull(),
  razaoSocial: varchar('razao_social', { length: 160 }),
  cnpj: varchar('cnpj', { length: 18 }),
  telefone: varchar('telefone', { length: 20 }),
  categoria: varchar('categoria', { length: 40 }).notNull(),
  prazoEntregaDias: integer('prazo_entrega_dias').default(10),
  ativo: boolean('ativo').default(true),
  contatoNome: varchar('contato_nome', { length: 120 }),
  whatsapp: varchar('whatsapp', { length: 20 }),
  email: varchar('email', { length: 150 }),
  cep: varchar('cep', { length: 10 }),
  logradouro: varchar('logradouro', { length: 160 }),
  numero: varchar('numero', { length: 20 }),
  complemento: varchar('complemento', { length: 100 }),
  bairro: varchar('bairro', { length: 100 }),
  cidade: varchar('cidade', { length: 100 }),
  uf: char('uf', { length: 2 }),
  chavePix: varchar('chave_pix', { length: 140 }),
  observacoes: text('observacoes'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  nomeBusca: text('nome_busca').generatedAlwaysAs(sql`f_busca(nome_fantasia || ' ' || COALESCE(razao_social, ''))`),
});

export const precosBarraTrilho = pgTable('precos_barra_trilho', {
  produtoId: uuid('produto_id').notNull(),
  tamanhoM: integer('tamanho_m').notNull(),
  custo: numeric('custo', { precision: 12, scale: 4 }).notNull(),
  venda: numeric('venda', { precision: 12, scale: 4 }).notNull(),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.produtoId, t.tamanhoM] })]);

export const tabelas = {
  lojas, parametrosSistema, usuarios, sessoes, categoriasProduto, produtos, precosBarraTrilho,
  historicoPrecosProduto, clientes, fornecedores,
};
