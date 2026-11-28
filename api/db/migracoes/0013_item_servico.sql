-- 0013 - Item só de serviço no orçamento (Gabriel, 27/11/2026): instalar ou consertar algo
-- que o cliente já tem, sem vender produto. Arquivo separado: o valor novo do enum só pode
-- ser usado depois que esta transação termina.
ALTER TYPE tipo_item_composto_enum ADD VALUE IF NOT EXISTS 'SERVICO';
