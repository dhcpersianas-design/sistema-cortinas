-- 0001 - Estrutura do banco (seção 8 da Especificação Técnica v1.1).
-- Copiado da especificação; mudanças da fundação marcadas com [fundação].

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ENUMS
CREATE TYPE unidade_medida_enum AS ENUM ('M2', 'ML', 'UN', 'PC');
CREATE TYPE tipo_pessoa_enum AS ENUM ('PF', 'PJ');
-- [fundação] Só 2 perfis (decisão do Gabriel, 27/11/2026): ADMIN (acesso total)
-- e VENDEDOR (vendedor em campo). FINANCEIRO e INSTALADOR da especificação saíram;
-- as funções deles ficam com o ADMIN. Ver docs/decisoes.md.
CREATE TYPE perfil_usuario_enum AS ENUM ('ADMIN', 'VENDEDOR');
CREATE TYPE status_orcamento_enum AS ENUM (
  'RASCUNHO', 'ENVIADO', 'AGUARDANDO_MEDICAO', 'EM_NEGOCIACAO', 'APROVADO',
  'PERDIDO', 'EXPIRADO'  -- v1.1: AGUARDANDO_MEDICAO
);
CREATE TYPE status_pedido_enum AS ENUM (
  'CONFERENCIA_MEDIDAS', 'AGUARDANDO_SINAL', 'EM_COMPRA',  -- v1.1: substitui AGUARDANDO_MEDICAO_FINAL
  'EM_PRODUCAO', 'PRONTO_ESTOQUE', 'INSTALACAO_AGENDADA',
  'INSTALADO_CONCLUIDO', 'CANCELADO'
);
CREATE TYPE tipo_item_composto_enum AS ENUM ('CORTINA', 'PERSIANA', 'AVULSO');
CREATE TYPE forma_pagamento_enum AS ENUM (
  'PIX', 'CREDITO_AVISTA', 'CREDITO_PARCELADO', 'DEBITO', 'BOLETO', 'DINHEIRO', 'MISTO'
);
CREATE TYPE tipo_lancamento_enum AS ENUM ('RECEITA', 'DESPESA');
CREATE TYPE status_lancamento_enum AS ENUM ('PREVISTO', 'LIQUIDADO', 'ATRASADO', 'CANCELADO');
CREATE TYPE status_medicao_enum AS ENUM ('AGENDADA', 'REALIZADA', 'CANCELADA');

-- 0. LOJAS (v1.1: MVP com 1 loja; loja_id nas tabelas principais)
CREATE TABLE lojas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       VARCHAR(120) NOT NULL,
  cnpj       VARCHAR(18),
  ativo      BOOLEAN DEFAULT TRUE
);

-- 0.1 PARAMETROS DO SISTEMA (v1.1: semaforo e impostos, com vigencia)
CREATE TABLE parametros_sistema (
  id               SERIAL PRIMARY KEY,
  loja_id          UUID NOT NULL REFERENCES lojas(id),
  chave            VARCHAR(60) NOT NULL,  -- ex: SEMAFORO_VERDE_MIN_PCT
  valor            NUMERIC(12,4) NOT NULL,
  vigente_desde    DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (loja_id, chave, vigente_desde)
);

-- 1. USUARIOS (EQUIPE)
CREATE TABLE usuarios (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id           UUID NOT NULL REFERENCES lojas(id),
  nome              VARCHAR(120) NOT NULL,
  email             VARCHAR(150) UNIQUE NOT NULL,
  senha_hash        TEXT NOT NULL,
  perfil            perfil_usuario_enum NOT NULL,
  comissao_padrao   NUMERIC(5,2) DEFAULT 0.00,
  pode_ver_custos   BOOLEAN DEFAULT FALSE,
  desconto_max_pct  NUMERIC(5,2) DEFAULT 10.00,
  ativo             BOOLEAN DEFAULT TRUE,
  criado_em         TIMESTAMPTZ DEFAULT NOW(),
  -- [fundação] colunas de autenticação
  deve_trocar_senha BOOLEAN NOT NULL DEFAULT FALSE,
  ultimo_login_em   TIMESTAMPTZ
);

-- [fundação] Sessões de login (cookie httpOnly). Guarda só o SHA-256 do token,
-- para permitir derrubar acessos (ex.: vendedor desligado) na hora.
CREATE TABLE sessoes (
  id             CHAR(64) PRIMARY KEY,            -- sha256(token) em hex
  usuario_id     UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultimo_uso_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em      TIMESTAMPTZ NOT NULL,
  ip             VARCHAR(64),
  user_agent     VARCHAR(300)
);
CREATE INDEX idx_sessoes_usuario ON sessoes (usuario_id);

-- 2. CLIENTES (CRM)
CREATE TABLE clientes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id           UUID NOT NULL REFERENCES lojas(id),
  nome_completo          VARCHAR(150) NOT NULL,
  tipo_pessoa            tipo_pessoa_enum DEFAULT 'PF',
  cpf_cnpj               VARCHAR(18) UNIQUE,
  telefone_whatsapp      VARCHAR(20) NOT NULL,
  telefone_secundario    VARCHAR(20),
  email                  VARCHAR(150),
  origem_lead            VARCHAR(60),
  cep                    VARCHAR(10),
  logradouro             VARCHAR(160),
  numero                 VARCHAR(20),
  complemento            VARCHAR(100),
  bairro                 VARCHAR(100),
  cidade                 VARCHAR(100),
  uf                     CHAR(2),
  tipo_imovel            VARCHAR(30),
  obs_acesso_instalacao  TEXT,
  data_registro          TIMESTAMPTZ DEFAULT NOW(),
  ultima_compra_em       TIMESTAMPTZ,
  ultima_instalacao_em   TIMESTAMPTZ,
  ativo                  BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_clientes_nome_trgm ON clientes USING gin (nome_completo gin_trgm_ops);
CREATE INDEX idx_clientes_telefone  ON clientes (telefone_whatsapp);
CREATE INDEX idx_clientes_email     ON clientes (email);

-- 3. FORNECEDORES
CREATE TABLE fornecedores (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_fantasia         VARCHAR(140) NOT NULL,
  razao_social          VARCHAR(160),
  cnpj                  VARCHAR(18),
  telefone              VARCHAR(20),
  categoria             VARCHAR(40) NOT NULL, -- TECIDO, PERSIANA, FERRAGEM, COSTUREIRA, INSTALADOR
  prazo_entrega_dias    INT DEFAULT 10,
  ativo                 BOOLEAN DEFAULT TRUE
);

-- 4. CATEGORIAS E PRODUTOS (CATALOGO DE COMPONENTES)
CREATE TABLE categorias_produto (
  id              SERIAL PRIMARY KEY,
  nome            VARCHAR(80) NOT NULL UNIQUE,
  tipo_grupo      VARCHAR(30) NOT NULL,
  ordem_exibicao  INT DEFAULT 0
);

CREATE TABLE produtos (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                  VARCHAR(30) UNIQUE NOT NULL,
  categoria_id         INT NOT NULL REFERENCES categorias_produto(id),
  fornecedor_padrao_id UUID REFERENCES fornecedores(id),
  nome                 VARCHAR(160) NOT NULL,
  cor_colecao          VARCHAR(80),
  unidade_medida       unidade_medida_enum NOT NULL,
  custo_unitario       NUMERIC(12,4) NOT NULL,
  preco_venda_unitario NUMERIC(12,4) NOT NULL,
  metadata_tecnica     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ativo                BOOLEAN DEFAULT TRUE,
  atualizado_em        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE historico_precos_produto (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id     UUID NOT NULL REFERENCES produtos(id),
  custo_anterior NUMERIC(12,4),
  custo_novo     NUMERIC(12,4),
  venda_anterior NUMERIC(12,4),
  venda_nova     NUMERIC(12,4),
  alterado_por   UUID REFERENCES usuarios(id),
  alterado_em    TIMESTAMPTZ DEFAULT NOW()
);

-- [fundação] Preço do trilho/varão por tamanho de barra (1 a 6 m), preenchido
-- pelo Gabriel. Substitui a planilha dados/precos-barra-trilho.csv do motor como
-- fonte em produção (a planilha continua servindo para importação).
CREATE TABLE precos_barra_trilho (
  produto_id     UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  tamanho_m      INT NOT NULL CHECK (tamanho_m BETWEEN 1 AND 6),
  custo          NUMERIC(12,4) NOT NULL CHECK (custo >= 0),
  venda          NUMERIC(12,4) NOT NULL CHECK (venda >= 0),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (produto_id, tamanho_m)
);

-- 5. ORCAMENTOS, ITENS COMPOSTOS E COMPONENTES (EXPLOSAO BOM IMUTAVEL)
CREATE TABLE orcamentos (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id           UUID NOT NULL REFERENCES lojas(id),
  codigo_sequencial          VARCHAR(30) UNIQUE NOT NULL,
  versao                     INT NOT NULL DEFAULT 1,
  orcamento_origem_id        UUID REFERENCES orcamentos(id),
  cliente_id                 UUID NOT NULL REFERENCES clientes(id),
  vendedor_id                UUID NOT NULL REFERENCES usuarios(id),
  status                     status_orcamento_enum NOT NULL DEFAULT 'RASCUNHO',
  motivo_perda               VARCHAR(120),
  data_criacao               TIMESTAMPTZ DEFAULT NOW(),
  validade_ate               DATE,
  data_aprovacao             TIMESTAMPTZ,
  subtotal_venda             NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  desconto_valor             NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  desconto_percentual        NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  acrescimo_outros           NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  valor_total_venda          NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  custo_total_previsto       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  lucro_bruto_previsto       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  margem_prevista_pct        NUMERIC(6,2) NOT NULL DEFAULT 0.00,
  forma_pagamento_prevista   forma_pagamento_enum,
  parcelas                   INT DEFAULT 1,
  taxa_financeira_pct        NUMERIC(5,2) DEFAULT 0.00,
  observacoes_cliente        TEXT,
  observacoes_internas       TEXT
);

CREATE TABLE orcamento_itens_compostos (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orcamento_id           UUID NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
  ambiente               VARCHAR(100) NOT NULL,
  tipo_item              tipo_item_composto_enum NOT NULL,
  descricao_comercial    TEXT NOT NULL,
  largura_bruta_m        NUMERIC(8,4),
  altura_bruta_m         NUMERIC(8,4),
  largura_producao_m     NUMERIC(8,4) NOT NULL,
  altura_producao_m      NUMERIC(8,4) NOT NULL,
  especificacoes_tecnicas JSONB NOT NULL DEFAULT '{}'::jsonb,
  fotos_vao_urls         JSONB NOT NULL DEFAULT '[]'::jsonb,
  custo_total_item       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  venda_total_item       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ordem                  INT DEFAULT 1
);

CREATE TABLE orcamento_componentes (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_composto_id          UUID NOT NULL REFERENCES orcamento_itens_compostos(id) ON DELETE CASCADE,
  produto_id                UUID NOT NULL REFERENCES produtos(id),
  fornecedor_id             UUID REFERENCES fornecedores(id),
  sku_snapshot              VARCHAR(30) NOT NULL,
  descricao_snapshot        VARCHAR(160) NOT NULL,
  unidade_medida_snapshot   unidade_medida_enum NOT NULL,
  quantidade_calculada      NUMERIC(10,4) NOT NULL,
  quantidade_override       NUMERIC(10,4),
  quantidade_final          NUMERIC(10,4) NOT NULL,
  formula_aplicada_log      VARCHAR(255),
  custo_unitario_snapshot   NUMERIC(12,4) NOT NULL,
  custo_total               NUMERIC(12,2) NOT NULL,
  preco_unitario_snapshot   NUMERIC(12,4) NOT NULL,
  preco_total               NUMERIC(12,2) NOT NULL,
  desconto_rateado          NUMERIC(12,2) NOT NULL DEFAULT 0.00, -- v1.1
  preco_total_liquido       NUMERIC(12,2) NOT NULL DEFAULT 0.00  -- v1.1
);

-- 5.1 MEDICOES TECNICAS (v1.1)
CREATE TABLE medicoes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id           UUID NOT NULL REFERENCES lojas(id),
  orcamento_id      UUID NOT NULL REFERENCES orcamentos(id),
  tecnico_id        UUID REFERENCES usuarios(id), -- [fundação] o vendedor em campo mede
  status            status_medicao_enum NOT NULL DEFAULT 'AGENDADA',
  data_agendada     TIMESTAMPTZ NOT NULL,
  data_realizada    TIMESTAMPTZ,
  orcamento_gerado_id UUID REFERENCES orcamentos(id), -- versao v2 gerada
  fotos_urls        JSONB NOT NULL DEFAULT '[]'::jsonb,
  observacoes       TEXT
);

-- 6. PEDIDOS, PRODUCAO E INSTALACAO
CREATE TABLE pedidos (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id           UUID NOT NULL REFERENCES lojas(id),
  numero_pedido               VARCHAR(30) UNIQUE NOT NULL,
  orcamento_id                UUID UNIQUE NOT NULL REFERENCES orcamentos(id),
  cliente_id                  UUID NOT NULL REFERENCES clientes(id),
  vendedor_id                 UUID NOT NULL REFERENCES usuarios(id),
  -- [fundação] Sem perfil INSTALADOR: a instalação é de equipe/terceiro
  -- cadastrado em fornecedores (categoria INSTALADOR). Confirmado: instalação terceirizada.
  instalador_fornecedor_id    UUID REFERENCES fornecedores(id),
  status_operacional          status_pedido_enum NOT NULL DEFAULT 'AGUARDANDO_SINAL',
  data_compra                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_previsao_entrega       DATE,
  data_instalacao_agendada    TIMESTAMPTZ,
  data_instalacao_realizada   TIMESTAMPTZ,
  forma_pagamento_final       forma_pagamento_enum,
  valor_total_final           NUMERIC(12,2) NOT NULL,
  custo_real_consolidado      NUMERIC(12,2) DEFAULT 0.00,
  checklist_instalacao        JSONB DEFAULT '{}'::jsonb,
  termo_aceite_assinatura_url TEXT,
  obs_instalacao              TEXT,
  -- v1.1: nota fiscal apenas registrada (emissao fora do MVP)
  nfe_numero                  VARCHAR(20),
  nfe_chave                   VARCHAR(44),
  nfe_arquivo_url             TEXT,
  nfse_numero                 VARCHAR(20),
  nfse_arquivo_url            TEXT
);

-- 7. FINANCEIRO (CONTAS, PLANO DE CONTAS, TAXAS E LANCAMENTOS)
CREATE TABLE contas_financeiras (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id           UUID NOT NULL REFERENCES lojas(id),
  nome         VARCHAR(100) NOT NULL,
  tipo         VARCHAR(30) NOT NULL, -- CONTA_CORRENTE, CAIXA, MAQUININHA
  saldo_inicial NUMERIC(12,2) DEFAULT 0.00,
  ativo        BOOLEAN DEFAULT TRUE
);

CREATE TABLE taxas_pagamento (
  id               SERIAL PRIMARY KEY,
  forma_pagamento  forma_pagamento_enum NOT NULL,
  parcelas         INT NOT NULL DEFAULT 1,
  taxa_mdr_pct     NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  taxa_antecip_pct NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  UNIQUE (forma_pagamento, parcelas)
);

CREATE TABLE plano_contas (
  id         SERIAL PRIMARY KEY,
  codigo     VARCHAR(20) UNIQUE NOT NULL, -- Ex: 1.01, 2.01, 3.01
  nome       VARCHAR(100) NOT NULL,
  grupo_dre  VARCHAR(40) NOT NULL -- RECEITA, DEDUCAO, CMV, DESPESA_FIXA, DESPESA_VARIAVEL
);

CREATE TABLE lancamentos_financeiros (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id           UUID NOT NULL REFERENCES lojas(id),
  tipo              tipo_lancamento_enum NOT NULL,
  pedido_id         UUID REFERENCES pedidos(id),
  cliente_id        UUID REFERENCES clientes(id),
  fornecedor_id     UUID REFERENCES fornecedores(id),
  plano_conta_id    INT NOT NULL REFERENCES plano_contas(id),
  conta_id          UUID REFERENCES contas_financeiras(id),
  descricao         VARCHAR(200) NOT NULL,
  forma_pagamento   forma_pagamento_enum,
  numero_parcela    INT DEFAULT 1,
  total_parcelas    INT DEFAULT 1,
  valor_bruto       NUMERIC(12,2) NOT NULL,
  taxa_transacao    NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  valor_liquido     NUMERIC(12,2) NOT NULL,
  data_competencia  DATE NOT NULL,
  data_vencimento   DATE NOT NULL,
  data_liquidacao   DATE,
  status            status_lancamento_enum NOT NULL DEFAULT 'PREVISTO',
  criado_em         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_lanc_competencia ON lancamentos_financeiros (data_competencia);
CREATE INDEX idx_lanc_vencimento  ON lancamentos_financeiros (data_vencimento);
CREATE INDEX idx_lanc_pedido      ON lancamentos_financeiros (pedido_id);

-- 8. VIEW DE PESQUISA COMPLETA DE CLIENTES (CRM HISTORICO)
CREATE OR REPLACE VIEW vw_clientes_historico_pesquisa AS
SELECT
  c.id AS cliente_id,
  c.nome_completo,
  c.telefone_whatsapp,
  c.email,
  CONCAT_WS(', ', c.logradouro, c.numero, c.bairro, c.cidade, c.uf) AS endereco_completo,
  c.data_registro,
  p.id AS pedido_id,
  p.numero_pedido,
  p.data_compra,
  p.data_instalacao_realizada AS data_instalacao,
  p.forma_pagamento_final AS forma_pagamento,
  p.valor_total_final,
  p.status_operacional,
  (
    SELECT STRING_AGG(oic.ambiente || ': ' || oic.descricao_comercial, ' | ')
    FROM orcamento_itens_compostos oic
    WHERE oic.orcamento_id = p.orcamento_id
  ) AS produtos_comprados
FROM clientes c
LEFT JOIN pedidos p ON p.cliente_id = c.id;
