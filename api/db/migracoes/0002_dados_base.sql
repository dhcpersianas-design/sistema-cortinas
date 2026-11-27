-- 0002 - Dados base (seção 8 da especificação): categorias, plano de contas,
-- loja única e parâmetros do sistema. Produtos NÃO entram aqui: o catálogo real
-- é cadastrado pelo Gabriel. Os 30 SKUs fictícios da especificação ficam em
-- db/exemplo/produtos-exemplo.sql (npm run db:exemplo).

-- CATEGORIAS
INSERT INTO categorias_produto (id, nome, tipo_grupo, ordem_exibicao) VALUES
  (1, 'Tecidos',                 'CORTINA',     1),
  (2, 'Trilhos e Varoes',        'CORTINA',     2),
  (3, 'Deslizantes e Fitas',     'CORTINA',     3),
  (4, 'Fixacao e Terminais',     'CORTINA',     4),
  (5, 'Mao de Obra Confeccao',   'SERVICO',     5),
  (6, 'Persianas Sob Medida',    'PERSIANA',    6),
  (7, 'Acabamentos Persiana',    'PERSIANA',    7),
  (8, 'Motorizacao e Automacao', 'MOTORIZACAO', 8),
  (9, 'Servicos de Instalacao',  'SERVICO',     9);
SELECT setval('categorias_produto_id_seq', (SELECT MAX(id) FROM categorias_produto));

-- PLANO DE CONTAS BASICO PARA DRE
INSERT INTO plano_contas (codigo, nome, grupo_dre) VALUES
  ('1.01', 'Venda de Cortinas Sob Medida',       'RECEITA'),
  ('1.02', 'Venda de Persianas e Motorizacao',   'RECEITA'),
  ('1.03', 'Servicos de Instalacao/Manutencao',  'RECEITA'),
  ('2.01', 'Impostos sobre Vendas (Simples)',    'DEDUCAO'),
  ('2.02', 'Taxas de Cartao / Boleto / Antecip.','DEDUCAO'),
  ('3.01', 'Custo Tecidos e Forros',             'CMV'),
  ('3.02', 'Custo Persianas e Acabamentos',      'CMV'),
  ('3.03', 'Custo Trilhos, Ferragens e Motores', 'CMV'),
  ('3.04', 'Custo Mao de Obra Costura/Atelie',   'CMV'),
  ('3.05', 'Custo Terceirizacao de Instalacao',  'CMV'),
  ('4.01', 'Comissoes de Vendedores e RT',       'DESPESA_VARIAVEL'),
  ('4.02', 'Combustivel / Visitas / Frete',      'DESPESA_VARIAVEL'),
  ('5.01', 'Aluguel / Condominio / Energia',     'DESPESA_FIXA'),
  ('5.02', 'Salarios / Pro-labore / Encargos',   'DESPESA_FIXA'),
  ('5.03', 'Marketing / Anuncios / Softwares',   'DESPESA_FIXA'),
  ('5.04', 'DAS MEI (imposto mensal fixo)',      'DESPESA_FIXA');
-- v1.1: loja e MEI. A conta 2.01 fica sem uso ate migrar para o Simples.

-- [fundação] Loja única (decisão 13). O nome é trocado depois pelo ADMIN.
INSERT INTO lojas (id, nome) VALUES ('00000000-0000-0000-0000-000000000001', 'Minha Loja');

-- PARÂMETROS (v1.1). Semáforo 45/35 (decisão 6), MEI sem alíquota sobre venda (decisão 8), markup 100%.
INSERT INTO parametros_sistema (loja_id, chave, valor, vigente_desde) VALUES
  ('00000000-0000-0000-0000-000000000001', 'SEMAFORO_VERDE_MIN_PCT',        45.00, '2026-01-01'),
  ('00000000-0000-0000-0000-000000000001', 'SEMAFORO_AMARELO_MIN_PCT',      35.00, '2026-01-01'),
  ('00000000-0000-0000-0000-000000000001', 'ALIQUOTA_IMPOSTO_VENDA_PCT',     0.00, '2026-01-01'),
  -- SUPOSIÇÃO: R$ 81.000,00 é o limite anual do MEI conhecido; conferir o valor legal vigente.
  ('00000000-0000-0000-0000-000000000001', 'LIMITE_FATURAMENTO_ANUAL_MEI', 81000.00, '2026-01-01'),
  ('00000000-0000-0000-0000-000000000001', 'ALERTA_LIMITE_MEI_PCT',         80.00, '2026-01-01'),
  -- Markup padrão (v1.1): venda sugerida = custo x 2. Não muda o semáforo (45/35).
  ('00000000-0000-0000-0000-000000000001', 'MARKUP_PADRAO_PCT',            100.00, '2026-01-01');
