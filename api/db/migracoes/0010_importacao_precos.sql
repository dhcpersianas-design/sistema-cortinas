-- Importação de tabela de preços por planilha (Excel/CSV), só ADMIN.
-- Cada importação aplicada fica registrada com o "antes e depois" de cada
-- produto/barra alterado, para consulta e para desfazer.

CREATE TABLE importacoes_preco (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id       UUID NOT NULL REFERENCES lojas(id),
  nome_arquivo  VARCHAR(200) NOT NULL,
  criado_por    UUID REFERENCES usuarios(id),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resumo        JSONB NOT NULL DEFAULT '{}'::jsonb,
  desfeita_em   TIMESTAMPTZ,
  desfeita_por  UUID REFERENCES usuarios(id)
);
CREATE INDEX idx_importacoes_preco_loja ON importacoes_preco (loja_id, criado_em DESC);

CREATE TABLE importacoes_preco_itens (
  id             BIGSERIAL PRIMARY KEY,
  importacao_id  UUID NOT NULL REFERENCES importacoes_preco(id) ON DELETE CASCADE,
  produto_id     UUID NOT NULL REFERENCES produtos(id),
  tamanho_m      INTEGER,
  acao           VARCHAR(20) NOT NULL CHECK (acao IN ('CRIOU_PRODUTO', 'ATUALIZOU_PRODUTO', 'CRIOU_BARRA', 'ATUALIZOU_BARRA')),
  antes          JSONB,
  depois         JSONB NOT NULL
);
CREATE INDEX idx_importacoes_preco_itens ON importacoes_preco_itens (importacao_id);

ALTER TABLE historico_precos_produto ADD COLUMN importacao_id UUID REFERENCES importacoes_preco(id);
