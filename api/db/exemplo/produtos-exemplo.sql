-- Catálogo FICTÍCIO da especificação (seções 7 e 8): 29 SKUs em 9 categorias (SRV-004/005 viraram uma faixa só).
-- Só para desenvolvimento, testes e demonstração. Não rodar no banco de produção.
-- Idempotente: SKUs já existentes não são alterados.
INSERT INTO produtos (sku, categoria_id, nome, unidade_medida, custo_unitario, preco_venda_unitario, metadata_tecnica) VALUES
  -- 1. Tecidos
  ('TEC-001', 1, 'Linho Sintetico Gaze',           'ML',  42.00,  110.00, '{"largura_rolo": 3.00, "permite_corte_horizontal": true, "eh_forro": false}'),
  ('TEC-002', 1, 'Forro Microfibra 80%',           'ML',  28.00,   75.00, '{"largura_rolo": 2.80, "permite_corte_horizontal": true, "eh_forro": true}'),
  ('TEC-003', 1, 'Blackout Emborrachado 100%',     'ML',  48.00,  125.00, '{"largura_rolo": 2.80, "permite_corte_horizontal": true, "eh_forro": true}'),
  -- 2. Trilhos e Varoes
  ('TRI-001', 2, 'Trilho Suico Max Simples',       'ML',  16.00,   45.00, '{"vias": 1, "min_ml": 1.00, "barra_max": 6.00}'),
  ('TRI-002', 2, 'Trilho Suico Duplo Largo',       'ML',  34.00,   89.00, '{"vias": 2, "min_ml": 1.00, "barra_max": 6.00}'),
  ('TRI-003', 2, 'Varao Aluminio 28mm Simples',    'ML',  25.00,   68.00, '{"vias": 1, "min_ml": 1.00, "tipo": "VARAO"}'),
  -- 3. Deslizantes e Fitas
  ('DES-001', 3, 'Deslizante Wave c/ Cordao 6.7cm','UN',   1.40,    3.80, '{"un_por_metro": 15, "exige_par_folha": true}'),
  ('DES-002', 3, 'Deslizante Max Comum',           'UN',   0.35,    1.20, '{"un_por_metro": 10, "exige_par_folha": false}'),
  ('DES-003', 3, 'Fita Entretela Wave 8cm',        'ML',   3.50,   10.00, '{"base_calculo": "ML_TECIDO_PRINCIPAL"}'),
  -- 4. Fixacao e Terminais
  ('FIX-001', 4, 'FinalClick / Terminal Trilho',   'UN',   2.50,    8.00, '{"qtd_por_via": 2}'),
  ('FIX-002', 4, 'Garra / Presilha Trilho Suico',  'UN',   2.00,    6.50, '{"espacamento_m": 0.50, "min_un": 2}'),
  ('FIX-003', 4, 'Emenda de Trilho Suico',         'PC',   6.00,   18.00, '{"inclusao": "MANUAL"}'),
  -- 5. Mao de Obra Confeccao
  ('MDO-001', 5, 'Confeccao Cortina Wave',         'ML',  22.00,   55.00, '{"base": "ML_TECIDO", "fator_pe_direito_alto": 1.30}'),
  ('MDO-002', 5, 'Confeccao Forro Simples/Wave',   'ML',  16.00,   40.00, '{"base": "ML_TECIDO", "fator_pe_direito_alto": 1.25}'),
  ('MDO-003', 5, 'Confeccao Prega Macho/Americana','ML',  25.00,   62.00, '{"base": "ML_TECIDO", "fator_pe_direito_alto": 1.30}'),
  -- 6. Persianas Sob Medida
  ('PER-001', 6, 'Persiana Rolo Tela Solar 3%',    'M2', 135.00,  320.00, '{"larg_min": 0.00, "alt_min": 1.20, "area_min": 1.50, "larg_max": 2.80}'),
  ('PER-002', 6, 'Persiana Rolo Blackout 100%',    'M2', 145.00,  345.00, '{"larg_min": 0.00, "alt_min": 1.20, "area_min": 1.50, "larg_max": 2.60}'),
  ('PER-003', 6, 'Persiana Double Vision',         'M2', 210.00,  490.00, '{"larg_min": 0.00, "alt_min": 1.20, "area_min": 1.50, "larg_max": 2.50}'),
  -- 7. Acabamentos Persiana
  ('ACP-001', 7, 'Bando Aluminio Pint. Eletrost.', 'ML',  52.00,  135.00, '{"min_ml": 1.00, "base": "LARGURA_PERSIANA"}'),
  ('ACP-002', 7, 'Guia Lateral / Perfil U',        'ML',  38.00,   95.00, '{"base": "2X_ALTURA_PERSIANA"}'),
  ('ACP-003', 7, 'Redutor de Peso / Mola Alivio',  'PC',  65.00,  160.00, '{"sugerir_largura_maior_m": 2.40}'),
  -- 8. Motorizacao e Automacao
  ('MOT-001', 8, 'Motor Tubular X Bivolt RF 6Nm',  'PC', 480.00, 1150.00, '{"torque_nm": 6, "tubo_compat": ["38mm", "45mm"]}'),
  ('MOT-002', 8, 'Controle Remoto RF 5 Canais',    'PC',  75.00,  190.00, '{"canais": 5, "escopo": "AMBIENTE_OU_ORCAMENTO"}'),
  ('MOT-003', 8, 'Hub Wi-Fi Alexa / Google Home',  'PC', 190.00,  450.00, '{"escopo": "ORCAMENTO"}'),
  -- 9. Servicos de Instalacao
  ('SRV-001', 9, 'Instalacao Cortina ate 3,00m',   'UN',  80.00,  180.00, '{"tipo": "CORTINA"}'),
  ('SRV-002', 9, 'Instalacao Persiana Manual',     'PC',  60.00,  140.00, '{"tipo": "PERSIANA_MANUAL"}'),
  ('SRV-003', 9, 'Instalacao Persiana Motorizada', 'PC', 110.00,  250.00, '{"tipo": "PERSIANA_MOTORIZADA"}'),
  -- Decisão do Gabriel (27/11/2026): sem tamanho máximo; acima de 3,00 m custa 2x a
  -- instalação normal (SRV-001). Valores fictícios. Substitui SRV-004/SRV-005 da v1.1.
  ('SRV-004', 9, 'Instalacao Cortina acima 3,00m', 'UN', 160.00,  360.00, '{"tipo": "CORTINA", "larg_min_m": 3.01, "multiplicador_sobre": "SRV-001", "multiplicador": 2}'),
  ('SRV-006', 9, 'Adicional Pe-Direito Alto >3m',  'UN',  60.00,  150.00, '{"tipo": "ADICIONAL", "alt_min_m": 3.01}')
ON CONFLICT (sku) DO NOTHING;
