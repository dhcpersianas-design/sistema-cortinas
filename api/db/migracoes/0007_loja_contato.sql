-- Contatos da loja no cabeçalho da proposta em PDF (telefone, e-mail e Instagram).
-- Valores iniciais da DHC Persianas & Cortinas, tirados do modelo de proposta enviado
-- pelo Gabriel (27/11/2026). Só preenche o que ainda estiver vazio.
ALTER TABLE lojas
  ADD COLUMN telefone  VARCHAR(20),
  ADD COLUMN email     VARCHAR(120),
  ADD COLUMN instagram VARCHAR(60);

UPDATE lojas SET
  cnpj      = COALESCE(NULLIF(cnpj, ''), '64.656.181/0001-91'),
  telefone  = '(41) 98837-5657',
  email     = 'dhc@dhcpersianas.com.br',
  instagram = '@dhcpersianas';
