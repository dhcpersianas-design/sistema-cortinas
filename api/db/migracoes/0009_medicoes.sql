-- 0009 - Agenda e medição técnica no local (especificação v1.1, seção 9 etapa 2, 12.5 e tabela 5.1).
-- A visita de medição é agendada para um cliente (ligada ao orçamento/pedido quando já existe),
-- o vendedor registra os vãos e as fotos na obra (funciona sem internet) e depois a medição é
-- CONFERIDA: no pedido em "Conferência de medidas" isso libera o pedido e começa a contar o prazo
-- de entrega (14 dias úteis); no orçamento, gera a nova versão com as medidas reais.
-- Mudanças em relação à especificação marcadas com [medição].

-- [medição] Medição pode ser marcada antes de existir orçamento (cliente ligou pedindo visita).
ALTER TABLE medicoes ALTER COLUMN orcamento_id DROP NOT NULL;
ALTER TABLE medicoes
  ADD COLUMN numero               VARCHAR(20) UNIQUE,                 -- MED-2026-0001
  ADD COLUMN cliente_id           UUID NOT NULL REFERENCES clientes(id),
  ADD COLUMN duracao_horas        NUMERIC(4,1),
  -- Vãos medidos na obra: [{id, ambiente, descricao, tipo, modo, larguras[], alturas[], ...}] (metros)
  ADD COLUMN vaos                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN obs_campo            TEXT,                               -- anotações de quem mediu
  ADD COLUMN registro_id          UUID UNIQUE,                        -- id gerado no aparelho: reenviar não duplica
  ADD COLUMN registrado_offline   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN registrado_por_id    UUID REFERENCES usuarios(id),
  ADD COLUMN conferida_em         TIMESTAMPTZ,
  ADD COLUMN conferida_por_id     UUID REFERENCES usuarios(id),
  ADD COLUMN cancelada_em         TIMESTAMPTZ,
  ADD COLUMN motivo_cancelamento  VARCHAR(200),
  ADD COLUMN criado_por_id        UUID REFERENCES usuarios(id),
  ADD COLUMN criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE SEQUENCE medicao_numero_seq;
CREATE INDEX idx_medicoes_data      ON medicoes (loja_id, data_agendada);
CREATE INDEX idx_medicoes_tecnico   ON medicoes (tecnico_id, data_agendada);
CREATE INDEX idx_medicoes_cliente   ON medicoes (cliente_id);
CREATE INDEX idx_medicoes_orcamento ON medicoes (orcamento_id) WHERE orcamento_id IS NOT NULL;

-- [medição] Fotos do vão guardadas no próprio banco (como a assinatura do aceite): entram no backup
-- diário e não dependem de serviço externo. O app reduz a foto antes de enviar (~200 KB).
CREATE TABLE medicao_fotos (
  id           UUID PRIMARY KEY,                       -- gerado no aparelho: reenviar não duplica
  medicao_id   UUID NOT NULL REFERENCES medicoes(id) ON DELETE CASCADE,
  vao_id       VARCHAR(40),                            -- vão a que a foto pertence (null = foto geral)
  legenda      VARCHAR(120),
  mime         VARCHAR(20) NOT NULL,
  tamanho      INT NOT NULL,
  conteudo     BYTEA NOT NULL,
  enviado_por_id UUID REFERENCES usuarios(id),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_medicao_fotos ON medicao_fotos (medicao_id, criado_em);
