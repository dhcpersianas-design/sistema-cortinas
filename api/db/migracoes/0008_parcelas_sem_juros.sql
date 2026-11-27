-- 0008 - Cartão sem juros até 3x (Gabriel, 27/11/2026).
-- PIX: tem o desconto do orçamento. Débito, crédito à vista e parcelado até PARCELAS_SEM_JUROS: valor
-- cheio (sem o desconto), a loja paga a taxa. De 4x a 12x: a taxa vai embutida no valor cheio.
INSERT INTO parametros_sistema (loja_id, chave, valor, vigente_desde)
  SELECT id, 'PARCELAS_SEM_JUROS', 3, '2026-01-01' FROM lojas
ON CONFLICT (loja_id, chave, vigente_desde) DO NOTHING;
