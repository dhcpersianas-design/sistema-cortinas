import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { conectar } from '../db/conexao.js';
import { lerConfig } from '../config.js';
import { lojas, usuarios } from '../db/schema.js';
import { gerarHashSenha, validarForcaSenha } from '../auth/senha.js';

/**
 * Cria o primeiro ADMIN (ou redefine a senha de um existente).
 *   npm run admin:criar -- --email gabriel@loja.com --nome "Gabriel"
 * Sem --senha (ou ADMIN_SENHA), gera uma senha provisória e mostra na tela;
 * o sistema pede a troca no primeiro acesso.
 */
const { values } = parseArgs({
  options: { email: { type: 'string' }, nome: { type: 'string' }, senha: { type: 'string' } },
});
const email = (values.email ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const nome = values.nome ?? process.env.ADMIN_NOME ?? 'Administrador';
let senha = values.senha ?? process.env.ADMIN_SENHA;
if (!email) {
  console.error('Informe o e-mail: npm run admin:criar -- --email voce@loja.com --nome "Seu nome"');
  process.exit(1);
}
const provisoria = !senha;
if (!senha) senha = randomBytes(9).toString('base64url') + '7a';
const fraca = validarForcaSenha(senha);
if (fraca) { console.error(fraca); process.exit(1); }

const { pool, db } = conectar(lerConfig().databaseUrl);
try {
  const [loja] = await db.select({ id: lojas.id }).from(lojas).limit(1);
  if (!loja) throw new Error('Nenhuma loja no banco. Rode antes: npm run db:migrar');
  const senhaHash = await gerarHashSenha(senha);
  const [existe] = await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, email));
  if (existe) {
    await db.update(usuarios).set({ senhaHash, perfil: 'ADMIN', ativo: true, deveTrocarSenha: provisoria }).where(eq(usuarios.id, existe.id));
    console.log(`Usuário ${email} agora é ADMIN e teve a senha redefinida.`);
  } else {
    await db.insert(usuarios).values({ lojaId: loja.id, nome, email, senhaHash, perfil: 'ADMIN', podeVerCustos: true, deveTrocarSenha: provisoria });
    console.log(`ADMIN criado: ${email}`);
  }
  if (provisoria) console.log(`Senha provisória (troque no primeiro acesso): ${senha}`);
} finally {
  await pool.end();
}
