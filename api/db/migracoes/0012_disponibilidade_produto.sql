-- 0012 - Status de disponibilidade do produto (pedido do Gabriel, 27/11/2026).
-- DISPONIVEL, EM_FALTA_SEM_PREVISAO, EM_FALTA_COM_PREVISAO (com data), FORA_DE_LINHA, SOB_CONSULTA.
-- Só para uso interno: aparece no catálogo e avisa o vendedor no orçamento; nunca vai para o PDF do cliente.
-- Diferente de "ativo": produto inativo some do catálogo; produto fora de linha continua visível, com aviso.

ALTER TABLE produtos
  ADD COLUMN disponibilidade VARCHAR(25) NOT NULL DEFAULT 'DISPONIVEL'
    CHECK (disponibilidade IN ('DISPONIVEL', 'EM_FALTA_SEM_PREVISAO', 'EM_FALTA_COM_PREVISAO', 'FORA_DE_LINHA', 'SOB_CONSULTA')),
  ADD COLUMN previsao_disponivel DATE,
  ADD CONSTRAINT ck_produtos_previsao CHECK (disponibilidade <> 'EM_FALTA_COM_PREVISAO' OR previsao_disponivel IS NOT NULL);
