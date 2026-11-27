import { readFileSync } from 'node:fs';
import { inArray, sql } from 'drizzle-orm';
import { CAMINHO_PRECOS_BARRA, lerPrecosBarraCSV } from '@sistema/motor-calculo';
import { conectar } from '../db/conexao.js';
import { lerConfig } from '../config.js';
import { precosBarraTrilho, produtos } from '../db/schema.js';

/**
 * Importa a planilha de preço por tamanho de barra para o banco.
 *   npm run precos-barra:importar               (usa motor-calculo/dados/precos-barra-trilho.csv)
 *   npm run precos-barra:importar -- caminho.csv
 * Usa o mesmo leitor do motor. Linhas vazias são ignoradas; linhas preenchidas
 * substituem o preço daquele SKU + tamanho.
 */
const caminho = process.argv[2] ?? CAMINHO_PRECOS_BARRA;
const { linhas, avisos } = lerPrecosBarraCSV(readFileSync(caminho, 'utf-8'));
const { pool, db } = conectar(lerConfig().databaseUrl);
try {
  const skus = [...new Set(linhas.map((l) => l.sku))];
  const achados = skus.length ? await db.select({ id: produtos.id, sku: produtos.sku }).from(produtos).where(inArray(produtos.sku, skus)) : [];
  const idPorSku = new Map(achados.map((p) => [p.sku, p.id]));
  const valores = [];
  for (const l of linhas) {
    const produtoId = idPorSku.get(l.sku);
    if (!produtoId) { avisos.push(`SKU ${l.sku} não existe no banco; linha ignorada.`); continue; }
    valores.push({ produtoId, tamanhoM: Number(l.tamanhoM), custo: l.custo, venda: l.venda });
  }
  if (valores.length) {
    await db.insert(precosBarraTrilho).values(valores).onConflictDoUpdate({
      target: [precosBarraTrilho.produtoId, precosBarraTrilho.tamanhoM],
      set: { custo: sql`excluded.custo`, venda: sql`excluded.venda`, atualizadoEm: sql`NOW()` },
    });
  }
  console.log(`Preços de barra gravados: ${valores.length}.`);
  for (const a of [...new Set(avisos)]) console.log(`Aviso: ${a}`);
} finally {
  await pool.end();
}
