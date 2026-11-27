import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';
import { aplicarRetencao, dataLocal } from '../src/backup.js';

let pool: pg.Pool;
let app: FastifyInstance;
let semBackup: FastifyInstance;
let pasta: string;
let admin: string;
let vendedor: string;

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'vendedor@loja.com', perfil: 'VENDEDOR' });
  pasta = mkdtempSync(join(tmpdir(), 'backups-'));
  app = await appTeste(1000, { pastaBackups: pasta, backupsManter: 3 });
  semBackup = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  vendedor = await entrar(app, 'vendedor@loja.com');
});
afterAll(async () => {
  await app.close(); await semBackup.close(); await pool.end();
  rmSync(pasta, { recursive: true, force: true });
});

describe('backups do banco', () => {
  it('só ADMIN acessa', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: { cookie: vendedor } });
    expect(r.statusCode).toBe(403);
    const r2 = await app.inject({ method: 'POST', url: '/api/admin/backups', headers: { cookie: vendedor } });
    expect(r2.statusCode).toBe(403);
  });

  it('gera o backup do dia, lista e baixa', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/backups', headers: { cookie: admin } });
    expect(r.statusCode).toBe(200);
    const nome = `cortinas-${dataLocal()}.dump`;
    expect(r.json().backup.arquivo).toBe(nome);
    const lista = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: { cookie: admin } });
    expect(lista.json()).toMatchObject({ ativo: true, manter: 3, backups: [{ arquivo: nome }] });
    const baixar = await app.inject({ method: 'GET', url: `/api/admin/backups/${nome}`, headers: { cookie: admin } });
    expect(baixar.statusCode).toBe(200);
    expect(baixar.headers['content-disposition']).toContain(nome);
    // Formato custom do pg_dump começa com "PGDMP".
    expect(baixar.rawPayload.subarray(0, 5).toString()).toBe('PGDMP');
    expect(readdirSync(pasta).filter((f) => f.endsWith('.parcial'))).toEqual([]);
  });

  it('recusa nomes fora do padrão', async () => {
    for (const nome of ['..%2F..%2Fetc%2Fpasswd', 'cortinas-2020-01-01.dump', 'qualquer.txt']) {
      const r = await app.inject({ method: 'GET', url: `/api/admin/backups/${nome}`, headers: { cookie: admin } });
      expect(r.statusCode).toBe(404);
    }
  });

  it('sem BACKUP_PASTA o recurso fica desligado', async () => {
    const c = await entrar(semBackup, 'admin@loja.com');
    const r = await semBackup.inject({ method: 'GET', url: '/api/admin/backups', headers: { cookie: c } });
    expect(r.json()).toMatchObject({ ativo: false, backups: [] });
    const r2 = await semBackup.inject({ method: 'POST', url: '/api/admin/backups', headers: { cookie: c } });
    expect(r2.statusCode).toBe(409);
  });

  it('retenção mantém só os mais recentes', () => {
    const p = mkdtempSync(join(tmpdir(), 'ret-'));
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) writeFileSync(join(p, `cortinas-${d}.dump`), 'x');
    writeFileSync(join(p, 'outro.txt'), 'x');
    expect(aplicarRetencao(p, 2)).toEqual(['cortinas-2026-01-02.dump', 'cortinas-2026-01-01.dump']);
    expect(readdirSync(p).sort()).toEqual(['cortinas-2026-01-03.dump', 'cortinas-2026-01-04.dump', 'outro.txt']);
    rmSync(p, { recursive: true, force: true });
  });
});
