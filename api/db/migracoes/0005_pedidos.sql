-- 0005 - Pedido, compras, produção e instalação (Fase 2 da especificação v1.1, seções 9, 12.3 e 12.4).
-- Orçamento aprovado vira pedido (1 por projeto), com CONFERENCIA_MEDIDAS quando a venda fechou antes
-- da medição. Mudança depois de aprovado = ADITIVO (nova versão do orçamento ligada ao pedido).
-- Compras agrupadas por fornecedor, ficha de corte e OS em PDF, agenda e aceite digital do cliente.
-- Mudanças em relação à especificação marcadas com [pedidos].

-- PEDIDOS
-- [pedidos] O pedido aponta para a versão do orçamento que vale hoje (orcamento_id). Cada aditivo
-- confirmado troca esse ponteiro para a nova versão; a versão aprovada na venda fica em
-- orcamento_aprovado_id. grupo_orcamento_id garante 1 pedido por projeto.
ALTER TABLE pedidos
  ADD COLUMN grupo_orcamento_id        UUID UNIQUE REFERENCES orcamentos(id),
  ADD COLUMN orcamento_aprovado_id     UUID REFERENCES orcamentos(id),
  ADD COLUMN titulo                    VARCHAR(120),
  ADD COLUMN valor_original            NUMERIC(12,2),
  ADD COLUMN criado_por_id             UUID REFERENCES usuarios(id),
  ADD COLUMN atualizado_em             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN medidas_conferidas_em     TIMESTAMPTZ,
  ADD COLUMN medidas_conferidas_por_id UUID REFERENCES usuarios(id),
  -- Sinal (o Contas a Receber completo é a Fase 3; aqui só o registro que libera as compras)
  ADD COLUMN sinal_valor               NUMERIC(12,2),
  ADD COLUMN sinal_forma               forma_pagamento_enum,
  ADD COLUMN sinal_recebido_em         DATE,
  ADD COLUMN compras_liberadas_em      TIMESTAMPTZ,
  ADD COLUMN compras_liberadas_por_id  UUID REFERENCES usuarios(id),
  ADD COLUMN liberado_sem_sinal        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Instalação
  ADD COLUMN instalacao_duracao_horas  NUMERIC(4,1),
  ADD COLUMN instalacao_agendada_por_id UUID REFERENCES usuarios(id),
  -- Cancelamento
  ADD COLUMN cancelado_em              TIMESTAMPTZ,
  ADD COLUMN motivo_cancelamento       VARCHAR(200),
  -- Nota fiscal (emitida no portal do governo; aqui só o registro)
  ADD COLUMN nf_registrada_em          TIMESTAMPTZ;

CREATE INDEX idx_pedidos_status   ON pedidos (status_operacional, data_compra DESC);
CREATE INDEX idx_pedidos_vendedor ON pedidos (vendedor_id, data_compra DESC);
CREATE INDEX idx_pedidos_cliente  ON pedidos (cliente_id);
CREATE INDEX idx_pedidos_agenda   ON pedidos (data_instalacao_agendada) WHERE data_instalacao_agendada IS NOT NULL;

-- Numeração PED-AAAA-NNNN e OC-AAAA-NNNN (uma sequência só; o ano entra no texto).
CREATE SEQUENCE pedido_numero_seq;
CREATE SEQUENCE ordem_compra_numero_seq;

-- ORÇAMENTO: versão rascunho aberta como aditivo de um pedido (editada no mesmo configurador).
ALTER TABLE orcamentos ADD COLUMN aditivo_pedido_id UUID REFERENCES pedidos(id);
CREATE INDEX idx_orcamentos_aditivo ON orcamentos (aditivo_pedido_id) WHERE aditivo_pedido_id IS NOT NULL;

-- ADITIVOS (12.4). Tipo CONFERENCIA_MEDIDAS = medição depois da venda; ALTERACAO = cliente pediu mudança.
CREATE TABLE pedido_aditivos (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id             UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  numero                INT NOT NULL,
  tipo                  VARCHAR(20) NOT NULL CHECK (tipo IN ('CONFERENCIA_MEDIDAS', 'ALTERACAO')),
  status                VARCHAR(12) NOT NULL DEFAULT 'RASCUNHO' CHECK (status IN ('RASCUNHO', 'CONFIRMADO', 'DESCARTADO')),
  orcamento_anterior_id UUID NOT NULL REFERENCES orcamentos(id),
  orcamento_novo_id     UUID REFERENCES orcamentos(id) ON DELETE SET NULL,
  valor_anterior        NUMERIC(12,2) NOT NULL,
  valor_novo            NUMERIC(12,2),
  diferenca             NUMERIC(12,2),
  motivo                VARCHAR(300),
  criado_por_id         UUID REFERENCES usuarios(id),
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmado_por_id     UUID REFERENCES usuarios(id),
  confirmado_em         TIMESTAMPTZ,
  UNIQUE (pedido_id, numero)
);
-- Só um aditivo em aberto por pedido.
CREATE UNIQUE INDEX idx_aditivo_aberto ON pedido_aditivos (pedido_id) WHERE status = 'RASCUNHO';

-- ORDENS DE COMPRA (explosão por fornecedor, seção 9 etapa 4)
-- [pedidos] Serviço de instalação (categoria 9) não vira compra: é do instalador, na agenda.
-- fornecedor_id vazio = componente sem fornecedor padrão no catálogo (o ADMIN escolhe).
CREATE TABLE ordens_compra (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id          UUID NOT NULL REFERENCES lojas(id),
  numero           VARCHAR(30) UNIQUE NOT NULL,
  pedido_id        UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  aditivo_id       UUID REFERENCES pedido_aditivos(id),
  fornecedor_id    UUID REFERENCES fornecedores(id),
  tipo             VARCHAR(12) NOT NULL DEFAULT 'COMPRA' CHECK (tipo IN ('COMPRA', 'COSTURA', 'FABRICA')),
  status           VARCHAR(12) NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA', 'ENVIADA', 'RECEBIDA', 'CANCELADA')),
  custo_previsto   NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  custo_real       NUMERIC(12,2),
  previsao_entrega DATE,
  observacoes      TEXT,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviada_em       TIMESTAMPTZ,
  recebida_em      TIMESTAMPTZ,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_oc_pedido     ON ordens_compra (pedido_id);
CREATE INDEX idx_oc_fornecedor ON ordens_compra (fornecedor_id, status);
CREATE INDEX idx_oc_status     ON ordens_compra (status, criado_em DESC);

CREATE TABLE ordem_compra_itens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ordem_id          UUID NOT NULL REFERENCES ordens_compra(id) ON DELETE CASCADE,
  item_composto_id  UUID,          -- sem FK: o item é da versão do orçamento (snapshot)
  ambiente          VARCHAR(100),
  produto_id        UUID REFERENCES produtos(id),
  sku               VARCHAR(30) NOT NULL,
  descricao         VARCHAR(160) NOT NULL,
  unidade           unidade_medida_enum NOT NULL,
  quantidade        NUMERIC(10,4) NOT NULL,
  custo_unitario    NUMERIC(12,4) NOT NULL,
  custo_total       NUMERIC(12,2) NOT NULL,
  ordem             INT NOT NULL DEFAULT 1
);
CREATE INDEX idx_oc_itens ON ordem_compra_itens (ordem_id, ordem);

-- HISTÓRICO DO PEDIDO (mesma ideia da auditoria do orçamento)
CREATE TABLE pedido_eventos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id   UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  usuario_id  UUID REFERENCES usuarios(id),
  acao        VARCHAR(40) NOT NULL,
  descricao   TEXT NOT NULL,
  detalhes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  offline     BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eventos_pedido ON pedido_eventos (pedido_id, criado_em);

-- ACEITE DIGITAL DO CLIENTE NA OBRA (seção 9 etapa 6). Feito no aparelho, mesmo sem internet.
-- [pedidos] A assinatura (PNG pequeno) fica no próprio banco: entra no backup diário sem
-- precisar de outro serviço de arquivos. id = UUID gerado no aparelho (reenviar não duplica).
CREATE TABLE pedido_aceites (
  id                  UUID PRIMARY KEY,
  pedido_id           UUID NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
  nome_recebedor      VARCHAR(150) NOT NULL,
  documento_recebedor VARCHAR(20),
  assinatura_png      BYTEA NOT NULL,
  checklist           JSONB NOT NULL DEFAULT '[]'::jsonb,
  observacoes         TEXT,
  ressalvas           BOOLEAN NOT NULL DEFAULT FALSE,
  assinado_em         TIMESTAMPTZ NOT NULL,      -- hora do aparelho (pode ter sido sem internet)
  recebido_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  usuario_id          UUID REFERENCES usuarios(id),
  offline             BOOLEAN NOT NULL DEFAULT FALSE
);

-- LINKS PÚBLICOS DOS PDFs PARA TERCEIROS (costureira, fábrica e instalador não têm login)
CREATE TABLE documentos_links_publicos (
  token_hash      CHAR(64) PRIMARY KEY,
  tipo            VARCHAR(20) NOT NULL CHECK (tipo IN ('FICHA_CORTE', 'PEDIDO_FABRICA', 'ORDEM_COMPRA', 'OS_INSTALACAO')),
  pedido_id       UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  ordem_compra_id UUID REFERENCES ordens_compra(id) ON DELETE CASCADE,
  criado_por_id   UUID REFERENCES usuarios(id),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em       TIMESTAMPTZ NOT NULL,
  acessos         INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_doc_links_pedido ON documentos_links_publicos (pedido_id);
