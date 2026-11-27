-- 0004 - Configurador de orçamento e proposta (Fase 2 da especificação v1.1, seção 13).
-- Orçamento por projeto e ambiente, explosão pelo motor com ajustes manuais auditados,
-- versões v1/v2 com snapshot congelado, desconto com trava de margem e link público do PDF.
-- Mudanças em relação à especificação marcadas com [orçamento].

-- ORÇAMENTOS
-- [orçamento] O código é do projeto (ORC-2026-0001) e se repete entre versões:
-- a chave única passa a ser (código, versão). grupo_id = id da v1 (todas as versões
-- do mesmo projeto apontam para ela).
ALTER TABLE orcamentos DROP CONSTRAINT orcamentos_codigo_sequencial_key;
ALTER TABLE orcamentos
  ADD COLUMN grupo_id                UUID REFERENCES orcamentos(id),
  ADD COLUMN titulo                  VARCHAR(120),            -- projeto/obra (ex.: "Apartamento 302")
  ADD COLUMN atualizado_em           TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', NOW()),
  ADD COLUMN criado_por_id           UUID REFERENCES usuarios(id),
  ADD COLUMN desconto_tipo           VARCHAR(10) NOT NULL DEFAULT 'PERCENTUAL'
                                     CHECK (desconto_tipo IN ('PERCENTUAL', 'VALOR')),
  ADD COLUMN desconto_informado      NUMERIC(12,2) NOT NULL DEFAULT 0.00, -- o que o vendedor digitou (% ou R$)
  -- Margem líquida (11.1 item 3): após taxa da forma de pagamento, imposto (MEI: 0) e comissão.
  ADD COLUMN taxa_pagamento_valor    NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN imposto_valor           NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN comissao_pct            NUMERIC(5,2)  NOT NULL DEFAULT 0.00,
  ADD COLUMN comissao_valor          NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN lucro_liquido_previsto  NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN margem_bruta_pct        NUMERIC(6,2)  NOT NULL DEFAULT 0.00,
  ADD COLUMN semaforo                VARCHAR(10),
  -- Liberação pelo ADMIN (margem vermelha ou desconto acima do limite do vendedor).
  -- Vale enquanto a margem não cair abaixo nem o desconto subir acima do que foi liberado.
  ADD COLUMN liberado_por_id         UUID REFERENCES usuarios(id),
  ADD COLUMN liberado_em             TIMESTAMPTZ,
  ADD COLUMN liberado_margem_pct     NUMERIC(6,2),
  ADD COLUMN liberado_desconto_pct   NUMERIC(5,2),
  -- Proposta
  ADD COLUMN prazo_entrega_dias      INT,
  ADD COLUMN garantia_texto          VARCHAR(300),
  ADD COLUMN condicoes_pagamento_texto VARCHAR(300),
  ADD COLUMN medidas_conferidas      BOOLEAN NOT NULL DEFAULT FALSE, -- false = PDF com aviso de conferência técnica
  -- Snapshot congelado: a versão enviada ao cliente não muda mais (mudança = nova versão).
  ADD COLUMN congelado_em            TIMESTAMPTZ,
  ADD COLUMN enviado_em              TIMESTAMPTZ,
  -- Última gravação aplicada (UUID gerado no aparelho): reenviar a mesma fila não aplica duas vezes.
  ADD COLUMN ultima_operacao_id      UUID UNIQUE;

UPDATE orcamentos SET grupo_id = id WHERE grupo_id IS NULL;
ALTER TABLE orcamentos ALTER COLUMN grupo_id SET NOT NULL;
-- Sem grupo informado, o orçamento é a v1 do próprio grupo.
CREATE OR REPLACE FUNCTION f_orcamento_grupo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.grupo_id := COALESCE(NEW.grupo_id, NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_orcamento_grupo BEFORE INSERT ON orcamentos FOR EACH ROW EXECUTE FUNCTION f_orcamento_grupo();
ALTER TABLE orcamentos ADD CONSTRAINT orcamentos_codigo_versao_key UNIQUE (codigo_sequencial, versao);
CREATE INDEX idx_orcamentos_grupo    ON orcamentos (grupo_id, versao DESC);
CREATE INDEX idx_orcamentos_vendedor ON orcamentos (vendedor_id, data_criacao DESC);
CREATE INDEX idx_orcamentos_cliente  ON orcamentos (cliente_id);

-- Numeração ORC-AAAA-NNNN (uma sequência só; o ano entra no texto).
CREATE SEQUENCE orcamento_numero_seq;

-- ITENS (um por vão; o ambiente é o agrupador do PDF)
-- [orçamento] entrada_calculo + ajustes = tudo o que é preciso para refazer a explosão;
-- hash_entrada detecta se o item mudou (item igual mantém o snapshot de preço).
ALTER TABLE orcamento_itens_compostos
  ADD COLUMN entrada_calculo   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN ajustes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN hash_entrada      CHAR(64),
  ADD COLUMN alertas           JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN desconto_rateado  NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN venda_liquida_item NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN calculado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX idx_itens_orcamento ON orcamento_itens_compostos (orcamento_id, ordem);

-- COMPONENTES (snapshot do BOM)
ALTER TABLE orcamento_componentes
  ADD COLUMN origem VARCHAR(10) NOT NULL DEFAULT 'MOTOR' CHECK (origem IN ('MOTOR', 'MANUAL')),
  ADD COLUMN ordem  INT NOT NULL DEFAULT 1,
  -- Componente incluído à mão não tem quantidade do motor.
  ALTER COLUMN quantidade_calculada DROP NOT NULL;
CREATE INDEX idx_componentes_item ON orcamento_componentes (item_composto_id, ordem);

-- AUDITORIA (regra de ouro 3: toda edição manual fica registrada)
CREATE TABLE orcamento_auditoria (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orcamento_id  UUID NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
  item_id       UUID,          -- sem FK: o item pode ter sido removido
  usuario_id    UUID REFERENCES usuarios(id),
  acao          VARCHAR(40) NOT NULL,
  descricao     TEXT NOT NULL,
  detalhes      JSONB NOT NULL DEFAULT '{}'::jsonb,
  offline       BOOLEAN NOT NULL DEFAULT FALSE,  -- veio do aparelho na obra
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_auditoria_orcamento ON orcamento_auditoria (orcamento_id, criado_em);

-- LINK PÚBLICO DO PDF (12.5: WhatsApp com link do PDF, com token e validade)
CREATE TABLE orcamento_links_publicos (
  token_hash    CHAR(64) PRIMARY KEY,   -- sha256 do token; o token só aparece na URL
  orcamento_id  UUID NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
  detalhar      BOOLEAN NOT NULL DEFAULT FALSE,
  criado_por_id UUID REFERENCES usuarios(id),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em     TIMESTAMPTZ NOT NULL,
  acessos       INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_links_orcamento ON orcamento_links_publicos (orcamento_id);

-- PARÂMETROS da proposta (valores iniciais; o ADMIN ajusta).
-- [orçamento] SUPOSIÇÃO: validade 15 dias, prazo 30 dias e garantia 12 meses até a loja informar os reais.
INSERT INTO parametros_sistema (loja_id, chave, valor, vigente_desde) VALUES
  ('00000000-0000-0000-0000-000000000001', 'VALIDADE_ORCAMENTO_DIAS', 15, '2026-01-01'),
  ('00000000-0000-0000-0000-000000000001', 'PRAZO_ENTREGA_PADRAO_DIAS', 30, '2026-01-01'),
  ('00000000-0000-0000-0000-000000000001', 'GARANTIA_MESES', 12, '2026-01-01')
ON CONFLICT DO NOTHING;
