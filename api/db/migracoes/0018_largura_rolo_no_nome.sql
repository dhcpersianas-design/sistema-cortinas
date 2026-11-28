-- Gabriel, 28/11/2026: largura do rolo padrão 3,00 m nos tecidos sem a medida (ele confere um a um
-- depois) e a largura SEMPRE no fim do nome do tecido: "[NOME DO TECIDO] - 3,00 MT".
-- Um gatilho no banco mantém o nome atualizado em qualquer caminho (cadastro, edição, planilha):
-- mudou a largura do rolo, muda o nome. A medida antiga escrita no meio do nome ("3,30", "2,80L",
-- "3 m") sai para não duplicar; o nome antigo fica guardado em metadata.nome_original.

-- Categorias de tecido: a raiz Tecidos (id 1), tipo TECIDO e todas as subcategorias.
CREATE OR REPLACE FUNCTION categorias_tecido() RETURNS TABLE (id INT) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE arvore AS (
    SELECT c.id FROM categorias_produto c WHERE c.id = 1 OR c.perfil = 'TECIDO'
    UNION
    SELECT c.id FROM categorias_produto c JOIN arvore a ON c.pai_id = a.id
  )
  SELECT arvore.id FROM arvore
$$;

-- "Linho Sintético 3,30 Médio" + 3.0 -> "Linho Sintético Médio - 3,00 MT".
CREATE OR REPLACE FUNCTION nome_com_largura_rolo(nome TEXT, largura NUMERIC) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  base TEXT := nome;
  sufixo TEXT := ' - ' || replace(to_char(largura, 'FM990.00'), '.', ',') || ' MT';
BEGIN
  base := regexp_replace(base, '\s*-\s*\d+(,\d+)?\s*MT\s*$', '', 'i');           -- sufixo antigo
  base := regexp_replace(base, '\s+\d,\d{1,2}\s*(mt|m|l)?(?=\s|$)', '', 'gi');   -- 3,30 / 2,80L / 3,00 m
  base := regexp_replace(base, '\s+[1-4]\s*(mt|m|l)(?=\s|$)', '', 'gi');          -- 3L / 3 m
  base := btrim(regexp_replace(base, '\s{2,}', ' ', 'g'));
  RETURN left(base, 160 - length(sufixo)) || sufixo;
END
$$;

CREATE OR REPLACE FUNCTION trg_tecido_largura_no_nome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.categoria_id IN (SELECT id FROM categorias_tecido()) THEN
    IF NOT (NEW.metadata_tecnica ? 'largura_rolo') OR jsonb_typeof(NEW.metadata_tecnica -> 'largura_rolo') <> 'number' THEN
      NEW.metadata_tecnica := NEW.metadata_tecnica || '{"largura_rolo": 3.0}'::jsonb;
    END IF;
    NEW.nome := nome_com_largura_rolo(NEW.nome, (NEW.metadata_tecnica ->> 'largura_rolo')::numeric);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tecido_largura_no_nome
  BEFORE INSERT OR UPDATE OF nome, metadata_tecnica, categoria_id ON produtos
  FOR EACH ROW EXECUTE FUNCTION trg_tecido_largura_no_nome();

-- Tecidos que já existem: guarda o nome antigo e deixa o gatilho preencher largura (3,00 se faltar) e nome.
-- Quem já tinha a largura do rolo cadastrada mantém a medida dele.
UPDATE produtos
SET metadata_tecnica = metadata_tecnica || jsonb_build_object('nome_original', nome), atualizado_em = NOW()
WHERE categoria_id IN (SELECT id FROM categorias_tecido());
