-- 0003 - Cadastros (Fase 1 da especificação v1.1, seção 13):
-- CRM de clientes, fornecedores (inclui instaladores terceirizados) e catálogo
-- com histórico de preços (inclusive a tabela de barras do trilho).
-- Mudanças em relação à especificação marcadas com [cadastros].

-- Busca tolerante a acentos (seção 10): "joao" acha "João", "conceicao" acha "Conceição".
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- unaccent() não é IMMUTABLE; o wrapper com dicionário fixo é, e por isso pode
-- ser usado em coluna gerada e índice.
CREATE OR REPLACE FUNCTION f_busca(t TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, t)) $$;

-- CLIENTES
-- [cadastros] vendedor_responsavel_id: o VENDEDOR vê só os clientes dele (decisão
-- do Gabriel). Quem cadastra vira o responsável; o ADMIN pode transferir.
-- cpf_cnpj passa a ser guardado só com dígitos; telefone no padrão +55DDNNNNNNNNN.
ALTER TABLE clientes
  ADD COLUMN vendedor_responsavel_id UUID REFERENCES usuarios(id),
  ADD COLUMN criado_por_id           UUID REFERENCES usuarios(id),
  ADD COLUMN observacoes             TEXT,
  ADD COLUMN atualizado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN nome_busca              TEXT GENERATED ALWAYS AS (f_busca(nome_completo)) STORED;

CREATE INDEX idx_clientes_nome_busca_trgm ON clientes USING gin (nome_busca gin_trgm_ops);
CREATE INDEX idx_clientes_vendedor        ON clientes (vendedor_responsavel_id);

-- FORNECEDORES
-- [cadastros] Instalador e costureira terceirizados são fornecedores sem login
-- (decisão do Gabriel). Campos de contato, endereço e PIX para a OS e o pagamento.
-- A coluna `cnpj` aceita CPF (instalador pessoa física) ou CNPJ, só dígitos.
ALTER TABLE fornecedores
  ADD COLUMN contato_nome   VARCHAR(120),
  ADD COLUMN whatsapp       VARCHAR(20),
  ADD COLUMN email          VARCHAR(150),
  ADD COLUMN cep            VARCHAR(10),
  ADD COLUMN logradouro     VARCHAR(160),
  ADD COLUMN numero         VARCHAR(20),
  ADD COLUMN complemento    VARCHAR(100),
  ADD COLUMN bairro         VARCHAR(100),
  ADD COLUMN cidade         VARCHAR(100),
  ADD COLUMN uf             CHAR(2),
  ADD COLUMN chave_pix      VARCHAR(140),
  ADD COLUMN observacoes    TEXT,
  ADD COLUMN criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN nome_busca     TEXT GENERATED ALWAYS AS (f_busca(nome_fantasia || ' ' || COALESCE(razao_social, ''))) STORED,
  ADD CONSTRAINT fornecedores_categoria_check CHECK (categoria IN (
    'TECIDO', 'PERSIANA', 'FERRAGEM', 'MOTORIZACAO', 'COSTUREIRA', 'INSTALADOR', 'OUTRO'
  ));

CREATE INDEX idx_fornecedores_nome_busca_trgm ON fornecedores USING gin (nome_busca gin_trgm_ops);

-- HISTÓRICO DE PREÇOS
-- [cadastros] tamanho_m preenchido = mudança na tabela de barras do trilho (1 a 6 m);
-- vazio = mudança no custo/venda unitário do produto. motivo é opcional.
ALTER TABLE historico_precos_produto
  ADD COLUMN tamanho_m INT CHECK (tamanho_m BETWEEN 1 AND 6),
  ADD COLUMN motivo    VARCHAR(200);

CREATE INDEX idx_historico_precos_produto ON historico_precos_produto (produto_id, alterado_em DESC);

-- Produtos: busca por nome sem acento no catálogo.
ALTER TABLE produtos
  ADD COLUMN nome_busca TEXT GENERATED ALWAYS AS (f_busca(sku || ' ' || nome || ' ' || COALESCE(cor_colecao, ''))) STORED;
