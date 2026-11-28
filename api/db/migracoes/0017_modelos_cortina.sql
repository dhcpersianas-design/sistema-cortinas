-- Gabriel, 28/11/2026.
-- 1) Todos os tecidos de cortina (e forros) passam a "Pode virar o tecido (corte na horizontal)".
--    Vale para a categoria Tecidos e todas as subcategorias dela (e qualquer categoria do tipo Tecido).
WITH RECURSIVE arvore AS (
  SELECT id FROM categorias_produto WHERE id = 1 OR perfil = 'TECIDO'
  UNION
  SELECT c.id FROM categorias_produto c JOIN arvore a ON c.pai_id = a.id
)
-- Cortina não tem garantia (só persiana): tira a garantia que algum tecido tivesse.
UPDATE produtos
SET metadata_tecnica = (metadata_tecnica - 'garantia_meses') || '{"permite_corte_horizontal": true}'::jsonb, atualizado_em = NOW()
WHERE categoria_id IN (SELECT id FROM arvore)
  AND (COALESCE((metadata_tecnica ->> 'permite_corte_horizontal')::boolean, FALSE) = FALSE OR metadata_tecnica ? 'garantia_meses');

-- 2) Modelos prontos de cortina: o administrador monta (tecido primário, secundário opcional, trilho,
--    acessórios de cada tecido e da cortina, mão de obra) e o vendedor puxa o modelo no orçamento.
--    O item do orçamento guarda uma cópia do modelo (mudar o modelo depois não mexe em orçamento feito).
CREATE TABLE modelos_cortina (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                VARCHAR(160) NOT NULL,
  confeccao           VARCHAR(10) NOT NULL DEFAULT 'WAVE' CHECK (confeccao IN ('WAVE', 'PREGA', 'FRANZIDO')),
  tecido_sku          VARCHAR(30) NOT NULL,
  tecido_fator        NUMERIC(6,2),
  secundario_sku      VARCHAR(30),
  secundario_fator    NUMERIC(6,2),
  trilho_sku          VARCHAR(30) NOT NULL,
  -- [{ "sku": "...", "aplica": "PRIMARIO|SECUNDARIO|CORTINA", "regra": "DESLIZANTE|ENTRETELA|TERMINAL|GARRA|ML_TECIDO|ML_TRILHO|FIXA", "quantidade": 1 }]
  acessorios          JSONB NOT NULL DEFAULT '[]'::jsonb,
  mao_obra_sku        VARCHAR(30),
  instalacao_sku      VARCHAR(30),
  instalacao_acima3_sku VARCHAR(30),
  ativo               BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX modelos_cortina_nome ON modelos_cortina (LOWER(nome));
