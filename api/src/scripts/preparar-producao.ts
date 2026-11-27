import { and, eq } from 'drizzle-orm';
import { conectar } from '../db/conexao.js';
import { migrar } from '../db/migrar.js';
import { lerConfig } from '../config.js';
import { lojas, usuarios } from '../db/schema.js';
import { gerarHashSenha, validarForcaSenha } from '../auth/senha.js';

/**
 * Roda a cada início do container (antes da API subir):
 *  1. aplica as migrações pendentes (cria as tabelas e os dados base na 1ª vez);
 *  2. LOJA_NOME (opcional) dá nome à loja;
 *  3. se ainda NÃO existe nenhum ADMIN, cria o primeiro com ADMIN_EMAIL, ADMIN_NOME e
 *     ADMIN_SENHA_INICIAL. O sistema pede a troca da senha no primeiro acesso.
 *     Depois que existe um ADMIN, essas variáveis são ignoradas (nunca redefinem senha).
 * Nunca carrega o catálogo fictício de exemplo.
 */
const env = process.env;
const { pool, db } = conectar(lerConfig().databaseUrl);
try {
  // O banco pode demorar alguns segundos a aceitar conexões na primeira subida.
  for (let tentativa = 1; ; tentativa++) {
    try { await pool.query('SELECT 1'); break; } catch (e) {
      if (tentativa >= 30) throw new Error(`Banco não respondeu: ${(e as Error).message}`);
      console.log(`Aguardando o banco (${tentativa}/30)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const aplicadas = await migrar(pool);
  console.log(aplicadas.length ? `Migrações aplicadas: ${aplicadas.join(', ')}` : 'Banco já está atualizado.');

  const [loja] = await db.select({ id: lojas.id, nome: lojas.nome }).from(lojas).limit(1);
  if (!loja) throw new Error('Nenhuma loja no banco após as migrações.');
  const nomeLoja = env.LOJA_NOME?.trim();
  if (nomeLoja && nomeLoja !== loja.nome) {
    await db.update(lojas).set({ nome: nomeLoja.slice(0, 120) }).where(eq(lojas.id, loja.id));
    console.log(`Nome da loja: ${nomeLoja}`);
  }

  const [admin] = await db.select({ id: usuarios.id }).from(usuarios)
    .where(and(eq(usuarios.perfil, 'ADMIN'), eq(usuarios.ativo, true))).limit(1);
  if (admin) {
    console.log('Administrador já existe; ADMIN_SENHA_INICIAL ignorada (pode apagar essa variável).');
  } else {
    const email = (env.ADMIN_EMAIL ?? '').trim().toLowerCase();
    const senha = env.ADMIN_SENHA_INICIAL ?? '';
    const fraca = senha ? validarForcaSenha(senha) : 'vazia';
    if (!email || fraca) {
      console.warn('ATENÇÃO: nenhum administrador cadastrado. Defina ADMIN_EMAIL e ADMIN_SENHA_INICIAL'
        + (fraca && fraca !== 'vazia' ? ` (senha recusada: ${fraca})` : '') + ' e reinicie o serviço.');
    } else {
      const [existe] = await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, email));
      const senhaHash = await gerarHashSenha(senha);
      if (existe) {
        await db.update(usuarios).set({ senhaHash, perfil: 'ADMIN', ativo: true, podeVerCustos: true, deveTrocarSenha: true })
          .where(eq(usuarios.id, existe.id));
      } else {
        await db.insert(usuarios).values({
          lojaId: loja.id, nome: env.ADMIN_NOME?.trim() || 'Administrador', email, senhaHash,
          perfil: 'ADMIN', podeVerCustos: true, deveTrocarSenha: true,
        });
      }
      console.log(`Primeiro administrador criado: ${email} (troca de senha obrigatória no 1º acesso).`);
    }
  }
} finally {
  await pool.end();
}
