import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { usuarios } from '../db/schema.js';
import { gerarHashSenha, validarForcaSenha } from '../auth/senha.js';
import { encerrarSessoesDoUsuario } from '../auth/sessao.js';
import { exigir } from '../auth/plugin.js';

const pct = z.string().regex(/^\d{1,3}([.,]\d{1,2})?$/, 'Percentual inválido').transform((v) => v.replace(',', '.'))
  .refine((v) => Number(v) <= 100, 'Máximo 100%');

const corpoCriar = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(150),
  senhaInicial: z.string().max(200),
  perfil: z.enum(['ADMIN', 'VENDEDOR']).default('VENDEDOR'),
  podeVerCustos: z.boolean().default(false),
  descontoMaxPct: pct.default('10.00'),
  comissaoPadrao: pct.default('0.00'),
});

const corpoEditar = z.object({
  nome: z.string().trim().min(2).max(120).optional(),
  perfil: z.enum(['ADMIN', 'VENDEDOR']).optional(),
  podeVerCustos: z.boolean().optional(),
  descontoMaxPct: pct.optional(),
  comissaoPadrao: pct.optional(),
  ativo: z.boolean().optional(),
  novaSenha: z.string().max(200).optional(),
});

const colunasPublicas = {
  id: usuarios.id, nome: usuarios.nome, email: usuarios.email, perfil: usuarios.perfil,
  podeVerCustos: usuarios.podeVerCustos, descontoMaxPct: usuarios.descontoMaxPct,
  comissaoPadrao: usuarios.comissaoPadrao, ativo: usuarios.ativo, ultimoLoginEm: usuarios.ultimoLoginEm,
  deveTrocarSenha: usuarios.deveTrocarSenha,
};

/** Gestão da equipe: só ADMIN. */
export async function rotasUsuarios(app: FastifyInstance) {
  const soAdmin = { preHandler: exigir('usuarios.gerenciar') };

  app.get('/api/usuarios', soAdmin, async (req) => ({
    usuarios: await app.db.select(colunasPublicas).from(usuarios)
      .where(eq(usuarios.lojaId, req.usuario!.lojaId)).orderBy(asc(usuarios.nome)),
  }));

  app.post('/api/usuarios', soAdmin, async (req, res) => {
    const corpo = corpoCriar.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: corpo.error.issues[0]?.message ?? 'Dados inválidos.' });
    const fraca = validarForcaSenha(corpo.data.senhaInicial);
    if (fraca) return res.code(400).send({ erro: fraca });
    const [existe] = await app.db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, corpo.data.email));
    if (existe) return res.code(409).send({ erro: 'Já existe usuário com este e-mail.' });
    const { senhaInicial, ...dados } = corpo.data;
    const [novo] = await app.db.insert(usuarios).values({
      ...dados, lojaId: req.usuario!.lojaId, senhaHash: await gerarHashSenha(senhaInicial), deveTrocarSenha: true,
    }).returning(colunasPublicas);
    return res.code(201).send({ usuario: novo });
  });

  app.patch<{ Params: { id: string } }>('/api/usuarios/:id', soAdmin, async (req, res) => {
    const corpo = corpoEditar.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: corpo.error.issues[0]?.message ?? 'Dados inválidos.' });
    if (!z.string().uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Usuário não encontrado.' });
    const [alvo] = await app.db.select().from(usuarios).where(eq(usuarios.id, req.params.id));
    if (!alvo || alvo.lojaId !== req.usuario!.lojaId) return res.code(404).send({ erro: 'Usuário não encontrado.' });

    const proprio = alvo.id === req.usuario!.id;
    if (proprio && (corpo.data.ativo === false || corpo.data.perfil === 'VENDEDOR')) {
      return res.code(400).send({ erro: 'Você não pode desativar nem rebaixar o próprio acesso.' });
    }
    const { novaSenha, ...campos } = corpo.data;
    const mudancas: Partial<typeof usuarios.$inferInsert> = { ...campos };
    if (novaSenha !== undefined) {
      const fraca = validarForcaSenha(novaSenha);
      if (fraca) return res.code(400).send({ erro: fraca });
      mudancas.senhaHash = await gerarHashSenha(novaSenha);
      mudancas.deveTrocarSenha = true;
    }
    if (Object.keys(mudancas).length === 0) return res.code(400).send({ erro: 'Nada para alterar.' });
    const [atualizado] = await app.db.update(usuarios).set(mudancas).where(eq(usuarios.id, alvo.id)).returning(colunasPublicas);
    // Desativou, trocou senha ou mudou perfil: derruba as sessões abertas.
    if (corpo.data.ativo === false || novaSenha !== undefined || (corpo.data.perfil && corpo.data.perfil !== alvo.perfil)) {
      await encerrarSessoesDoUsuario(app.db, alvo.id);
    }
    return { usuario: atualizado };
  });
}
