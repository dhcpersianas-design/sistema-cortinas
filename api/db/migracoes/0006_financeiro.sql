-- 0006 - Financeiro e relatórios (Fase 3 da especificação v1.1, seções 9 e 11).
-- Contas a receber nascem do pedido (sinal e saldo); contas a pagar nascem das ordens de compra,
-- do instalador terceirizado e da comissão. Taxas de cartão por forma de pagamento, despesas fixas
-- (DAS do MEI), competência x caixa, lucro real por pedido, limite do MEI e pós-venda.
-- Mudanças em relação à especificação marcadas com [financeiro].

-- PLANO DE CONTAS: contas que faltavam para o dia a dia.
INSERT INTO plano_contas (codigo, nome, grupo_dre) VALUES
  ('1.04', 'Outras Receitas',                     'RECEITA'),
  ('2.03', 'Devolucoes e Abatimentos a Clientes', 'DEDUCAO'),
  ('4.03', 'Outras Despesas Variaveis',           'DESPESA_VARIAVEL'),
  ('5.05', 'Outras Despesas Fixas',               'DESPESA_FIXA')
ON CONFLICT (codigo) DO NOTHING;

-- TAXAS DE CARTÃO / BOLETO
-- [financeiro] dias_repasse = em quantos dias o dinheiro cai na conta (crédito parcelado: cada parcela
-- cai 30 dias depois da anterior, a não ser que haja taxa de antecipação, que adianta tudo de uma vez).
-- Valores começam em ZERO: o Gabriel preenche com as taxas da maquininha dele (tela Financeiro > Configurar).
ALTER TABLE taxas_pagamento ADD COLUMN dias_repasse INT NOT NULL DEFAULT 0 CHECK (dias_repasse BETWEEN 0 AND 120);
INSERT INTO taxas_pagamento (forma_pagamento, parcelas, taxa_mdr_pct, taxa_antecip_pct, dias_repasse) VALUES
  ('PIX', 1, 0, 0, 0), ('DINHEIRO', 1, 0, 0, 0), ('BOLETO', 1, 0, 0, 2),
  ('DEBITO', 1, 0, 0, 1), ('CREDITO_AVISTA', 1, 0, 0, 30)
ON CONFLICT (forma_pagamento, parcelas) DO NOTHING;
INSERT INTO taxas_pagamento (forma_pagamento, parcelas, taxa_mdr_pct, taxa_antecip_pct, dias_repasse)
  SELECT 'CREDITO_PARCELADO', n, 0, 0, 30 FROM generate_series(2, 12) AS n
ON CONFLICT (forma_pagamento, parcelas) DO NOTHING;

-- CONTAS (onde o dinheiro está). Saldo inicial editável na tela.
INSERT INTO contas_financeiras (loja_id, nome, tipo)
  SELECT '00000000-0000-0000-0000-000000000001', x.nome, x.tipo
    FROM (VALUES ('Banco', 'CONTA_CORRENTE'), ('Caixa (dinheiro)', 'CAIXA')) AS x(nome, tipo)
   WHERE EXISTS (SELECT 1 FROM lojas WHERE id = '00000000-0000-0000-0000-000000000001')
     AND NOT EXISTS (SELECT 1 FROM contas_financeiras);

-- DESPESAS FIXAS QUE SE REPETEM TODO MÊS (aluguel, DAS do MEI, internet...).
-- O sistema lança sozinho cada mês em Contas a pagar.
CREATE TABLE despesas_recorrentes (
  id              SERIAL PRIMARY KEY,
  loja_id         UUID NOT NULL REFERENCES lojas(id),
  descricao       VARCHAR(150) NOT NULL,
  plano_conta_id  INT NOT NULL REFERENCES plano_contas(id),
  fornecedor_id   UUID REFERENCES fornecedores(id),
  valor           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (valor >= 0),
  dia_vencimento  INT NOT NULL DEFAULT 10 CHECK (dia_vencimento BETWEEN 1 AND 28),
  inicio          DATE NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- DAS do MEI (decisão v1.1: imposto mensal fixo, conta 5.04). Começa desligado e sem valor:
-- o Gabriel informa o valor do DAS e liga. Vence todo dia 20.
INSERT INTO despesas_recorrentes (loja_id, descricao, plano_conta_id, valor, dia_vencimento, ativo)
  SELECT l.id, 'DAS MEI (imposto mensal)', pc.id, 0, 20, FALSE
    FROM lojas l, plano_contas pc WHERE pc.codigo = '5.04';

-- LANÇAMENTOS (contas a receber e a pagar)
-- [financeiro] origem diz de onde veio o lançamento; o sistema só mexe sozinho nos que ele criou e que
-- ainda não foram editados à mão (editado_manual). Status ATRASADO não é gravado: é PREVISTO com
-- vencimento no passado (calculado na consulta).
-- cartao = repasse da maquininha: o cliente já pagou, falta a operadora depositar. Cai sozinho como
-- LIQUIDADO no dia do vencimento.
ALTER TABLE lancamentos_financeiros
  ADD COLUMN origem                VARCHAR(20) NOT NULL DEFAULT 'MANUAL' CHECK (origem IN (
                                     'SINAL', 'SALDO', 'ADITIVO', 'RECEBIDO', 'CARTAO', 'ORDEM_COMPRA', 'INSTALACAO',
                                     'COMISSAO', 'DEVOLUCAO', 'RECORRENTE', 'MANUAL')),
  ADD COLUMN ordem_compra_id       UUID REFERENCES ordens_compra(id) ON DELETE SET NULL,
  ADD COLUMN vendedor_id           UUID REFERENCES usuarios(id),
  ADD COLUMN despesa_recorrente_id INT REFERENCES despesas_recorrentes(id) ON DELETE SET NULL,
  ADD COLUMN mes_referencia        DATE,
  ADD COLUMN cartao                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN grupo_pagamento_id    UUID,
  ADD COLUMN editado_manual        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN observacoes           TEXT,
  ADD COLUMN criado_por_id         UUID REFERENCES usuarios(id),
  ADD COLUMN liquidado_por_id      UUID REFERENCES usuarios(id),
  ADD COLUMN atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD CONSTRAINT lancamentos_valores_check CHECK (valor_bruto >= 0 AND taxa_transacao >= 0);

CREATE INDEX idx_lanc_aberto     ON lancamentos_financeiros (tipo, status, data_vencimento);
CREATE INDEX idx_lanc_liquidacao ON lancamentos_financeiros (data_liquidacao) WHERE data_liquidacao IS NOT NULL;
CREATE INDEX idx_lanc_ordem      ON lancamentos_financeiros (ordem_compra_id) WHERE ordem_compra_id IS NOT NULL;
CREATE INDEX idx_lanc_grupo      ON lancamentos_financeiros (grupo_pagamento_id) WHERE grupo_pagamento_id IS NOT NULL;
-- Uma despesa fixa por mês (o sistema pode tentar lançar de novo sem duplicar).
CREATE UNIQUE INDEX idx_lanc_recorrente_mes ON lancamentos_financeiros (despesa_recorrente_id, mes_referencia)
  WHERE despesa_recorrente_id IS NOT NULL;

-- PÓS-VENDA (seção 9 etapa 6): contato com o cliente alguns dias depois da instalação.
CREATE TABLE pos_venda (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id       UUID NOT NULL REFERENCES lojas(id),
  pedido_id     UUID NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
  data_prevista DATE NOT NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'FEITO', 'CANCELADO')),
  nota          INT CHECK (nota BETWEEN 1 AND 5),
  comentario    TEXT,
  feito_em      TIMESTAMPTZ,
  feito_por_id  UUID REFERENCES usuarios(id),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pos_venda_status ON pos_venda (status, data_prevista);

-- PARÂMETROS NOVOS
-- Sinal padrão do plano de recebimento (spec: "ex.: 50% de sinal na aprovação + 50% na instalação").
-- Dias do pós-venda depois da instalação (spec: "+7 dias").
INSERT INTO parametros_sistema (loja_id, chave, valor, vigente_desde)
  SELECT id, x.chave, x.valor, '2026-01-01' FROM lojas,
    (VALUES ('SINAL_PADRAO_PCT', 50.00), ('POS_VENDA_DIAS', 7.00)) AS x(chave, valor)
ON CONFLICT (loja_id, chave, vigente_desde) DO NOTHING;
