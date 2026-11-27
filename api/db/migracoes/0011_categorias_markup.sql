-- 0011 - Categorias em árvore e markup por categoria (pedido do Gabriel, 27/11/2026).
--
-- 4 categorias principais: Persianas, Tecidos, Acessórios Persianas, Acessórios Cortinas.
-- Mais "Serviços" (confecção e instalação), que o cálculo do orçamento precisa.
-- Persianas tem subcategorias: Horizontal, Vertical, Painel, Romana, Rolo
-- (Caixa Box, Double Vision, Rolo, Shangrilá), Celular e Magic.
--
-- Os ids antigos (1 a 9) continuam valendo: só mudam de nome e de lugar na árvore.
-- Produtos não perdem nada: muda só a categoria (persianas vão para a subcategoria
-- pelo nome; o que não der para adivinhar fica em "Persianas" e a tela pede a subcategoria).
--
-- perfil = que dados técnicos o cadastro pede (ver motor-calculo/src/cadastro.ts).
-- markup_pct = markup da categoria; vazio numa subcategoria = usa o da categoria de cima.

ALTER TABLE categorias_produto
  ADD COLUMN pai_id     INT REFERENCES categorias_produto(id),
  ADD COLUMN perfil     VARCHAR(30) NOT NULL DEFAULT 'GENERICO',
  ADD COLUMN markup_pct NUMERIC(7,2) CHECK (markup_pct IS NULL OR (markup_pct >= 0 AND markup_pct <= 1000));

-- O nome passa a ser único só dentro da mesma categoria de cima ("Rolo" > "Rolo").
ALTER TABLE categorias_produto DROP CONSTRAINT categorias_produto_nome_key;
CREATE UNIQUE INDEX uq_categorias_produto_nome ON categorias_produto (COALESCE(pai_id, 0), nome);

-- Categorias principais (reaproveita ids antigos onde dá).
UPDATE categorias_produto SET nome = 'Persianas',            tipo_grupo = 'PERSIANA', perfil = 'PERSIANA',           ordem_exibicao = 10 WHERE id = 6;
UPDATE categorias_produto SET nome = 'Tecidos',              tipo_grupo = 'CORTINA',  perfil = 'TECIDO',             ordem_exibicao = 20 WHERE id = 1;
UPDATE categorias_produto SET nome = 'Acessórios Persianas', tipo_grupo = 'PERSIANA', perfil = 'ACESSORIO_PERSIANA', ordem_exibicao = 30 WHERE id = 7;
INSERT INTO categorias_produto (id, nome, tipo_grupo, perfil, ordem_exibicao) VALUES
  (10, 'Acessórios Cortinas', 'CORTINA', 'ACESSORIO_CORTINA', 40),
  (11, 'Serviços',            'SERVICO', 'GENERICO',          50);

-- Subcategorias de Persianas.
INSERT INTO categorias_produto (id, nome, tipo_grupo, perfil, ordem_exibicao, pai_id) VALUES
  (20, 'Horizontal', 'PERSIANA', 'PERSIANA', 11, 6),
  (21, 'Vertical',   'PERSIANA', 'PERSIANA', 12, 6),
  (22, 'Painel',     'PERSIANA', 'PERSIANA', 13, 6),
  (23, 'Romana',     'PERSIANA', 'PERSIANA', 14, 6),
  (24, 'Rolo',       'PERSIANA', 'PERSIANA', 15, 6),
  (25, 'Celular',    'PERSIANA', 'PERSIANA', 16, 6),
  (26, 'Magic',      'PERSIANA', 'PERSIANA', 17, 6);
INSERT INTO categorias_produto (id, nome, tipo_grupo, perfil, ordem_exibicao, pai_id) VALUES
  (27, 'Caixa Box',     'PERSIANA', 'PERSIANA', 151, 24),
  (28, 'Double Vision', 'PERSIANA', 'PERSIANA', 152, 24),
  (29, 'Rolo',          'PERSIANA', 'PERSIANA', 153, 24),
  (30, 'Shangrilá',     'PERSIANA', 'PERSIANA', 154, 24);

-- Acessórios Persianas: peças/acabamentos (bandô, guia, garradeira, tampa, suporte) e motorização.
INSERT INTO categorias_produto (id, nome, tipo_grupo, perfil, ordem_exibicao, pai_id) VALUES
  (31, 'Peças e Acabamentos', 'PERSIANA', 'ACESSORIO_PERSIANA', 31, 7);
UPDATE categorias_produto SET nome = 'Motorização e Automação', pai_id = 7, perfil = 'MOTORIZACAO', ordem_exibicao = 32 WHERE id = 8;

-- Acessórios Cortinas: trilhos/varões, deslizantes/fitas/entretela, fixação/terminais.
UPDATE categorias_produto SET nome = 'Trilhos e Varões',     pai_id = 10, perfil = 'TRILHO',     ordem_exibicao = 41 WHERE id = 2;
UPDATE categorias_produto SET nome = 'Deslizantes e Fitas',  pai_id = 10, perfil = 'DESLIZANTE', ordem_exibicao = 42 WHERE id = 3;
UPDATE categorias_produto SET nome = 'Fixação e Terminais',  pai_id = 10, perfil = 'FIXACAO',    ordem_exibicao = 43 WHERE id = 4;

-- Serviços: confecção e instalação (id 9 continua sendo a instalação para pedidos e DRE).
UPDATE categorias_produto SET nome = 'Mão de Obra Confecção', pai_id = 11, perfil = 'CONFECCAO',  ordem_exibicao = 51 WHERE id = 5;
UPDATE categorias_produto SET nome = 'Instalação',            pai_id = 11, perfil = 'INSTALACAO', ordem_exibicao = 52 WHERE id = 9;

SELECT setval('categorias_produto_id_seq', GREATEST(100, (SELECT MAX(id) FROM categorias_produto)));

-- Markup: cada categoria principal começa com o markup padrão vigente (100% se não houver).
UPDATE categorias_produto SET markup_pct = COALESCE((
  SELECT valor FROM parametros_sistema WHERE chave = 'MARKUP_PADRAO_PCT' AND vigente_desde <= CURRENT_DATE
  ORDER BY vigente_desde DESC LIMIT 1), 100)
WHERE pai_id IS NULL;

-- Produtos: persianas vão para a subcategoria pelo nome/coleção (a ordem importa: o mais específico primeiro).
UPDATE produtos SET categoria_id = CASE
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%double vision%' THEN 28
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%caixa box%'     THEN 27
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%shangri%'       THEN 30
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%horizontal%'    THEN 20
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%vertical%'      THEN 21
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%painel%'        THEN 22
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%romana%'        THEN 23
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%celular%'       THEN 25
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%magic%'         THEN 26
    WHEN f_busca(nome || ' ' || COALESCE(cor_colecao, '')) LIKE '%rolo%'          THEN 29
    ELSE categoria_id END
WHERE categoria_id = 6;

-- Acabamentos de persiana (bandô, guia, redutor...) vão para "Peças e Acabamentos".
UPDATE produtos SET categoria_id = 31 WHERE categoria_id = 7;
