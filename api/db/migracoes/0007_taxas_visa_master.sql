-- 0007 - Taxas do cartão: só a tabela Visa/Mastercard (Gabriel, 27/11/2026).
-- Vale para qualquer bandeira; a tabela Elo/Amex sai do sistema. Débito não embute a taxa no valor
-- (regra no código: FORMAS_REPASSE), cobra o preço cheio e a loja paga a taxa.
DELETE FROM taxas_pagamento WHERE bandeira = 'ELO_AMEX';
