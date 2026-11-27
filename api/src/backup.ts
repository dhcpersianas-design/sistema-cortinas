import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Nome dos arquivos de backup: cortinas-AAAA-MM-DD.dump (formato custom do pg_dump). */
export const PADRAO_BACKUP = /^cortinas-\d{4}-\d{2}-\d{2}\.dump$/;

export interface ArquivoBackup { arquivo: string; bytes: number; criadoEm: string }

/** Data local (fuso do container, TZ) no formato AAAA-MM-DD. */
export function dataLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function listarBackups(pasta: string): ArquivoBackup[] {
  let nomes: string[];
  try { nomes = readdirSync(pasta); } catch { return []; }
  return nomes.filter((n) => PADRAO_BACKUP.test(n)).sort().reverse().map((arquivo) => {
    const s = statSync(join(pasta, arquivo));
    return { arquivo, bytes: s.size, criadoEm: s.mtime.toISOString() };
  });
}

/** Apaga os mais antigos, mantendo os `manter` mais recentes. */
export function aplicarRetencao(pasta: string, manter: number): string[] {
  const apagar = listarBackups(pasta).slice(Math.max(1, manter));
  for (const b of apagar) rmSync(join(pasta, b.arquivo), { force: true });
  return apagar.map((b) => b.arquivo);
}

function rodar(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((ok, falha) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let erro = '';
    p.stderr.on('data', (b) => { erro += String(b); });
    p.on('error', falha);
    p.on('close', (codigo) => (codigo === 0 ? ok() : falha(new Error(`${cmd} saiu com código ${codigo}: ${erro.trim()}`))));
  });
}

/**
 * Gera o backup do dia com pg_dump (arquivo temporário + rename, para nunca
 * deixar um backup pela metade com o nome final). Refazer no mesmo dia substitui.
 */
export async function fazerBackup(databaseUrl: string, pasta: string, manter: number): Promise<ArquivoBackup> {
  mkdirSync(pasta, { recursive: true });
  const arquivo = `cortinas-${dataLocal()}.dump`;
  const final = join(pasta, arquivo);
  const parcial = `${final}.parcial`;
  // A URL vai por variável de ambiente para a senha não aparecer na lista de processos.
  const url = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
  if (url.searchParams.get('sslmode')) env.PGSSLMODE = url.searchParams.get('sslmode')!;
  try {
    await rodar('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${parcial}`], env);
    renameSync(parcial, final);
  } finally {
    rmSync(parcial, { force: true });
  }
  aplicarRetencao(pasta, manter);
  const s = statSync(final);
  return { arquivo, bytes: s.size, criadoEm: s.mtime.toISOString() };
}

/**
 * Backup diário automático: confere a cada 30 min; se já passou da hora marcada
 * e ainda não há backup de hoje, faz. Sobrevive a reinícios (olha os arquivos).
 */
export function agendarBackupDiario(opcoes: {
  databaseUrl: string; pasta: string; manter: number; hora: number;
  log: { info: (m: string) => void; error: (m: string) => void };
}): () => void {
  let rodando = false;
  const conferir = async () => {
    if (rodando || new Date().getHours() < opcoes.hora) return;
    if (listarBackups(opcoes.pasta).some((b) => b.arquivo === `cortinas-${dataLocal()}.dump`)) return;
    rodando = true;
    try {
      const b = await fazerBackup(opcoes.databaseUrl, opcoes.pasta, opcoes.manter);
      opcoes.log.info(`Backup diário gravado: ${b.arquivo} (${b.bytes} bytes)`);
    } catch (e) {
      opcoes.log.error(`Backup diário falhou: ${(e as Error).message}`);
    } finally {
      rodando = false;
    }
  };
  const t = setInterval(conferir, 30 * 60_000);
  t.unref();
  setTimeout(conferir, 60_000).unref();
  return () => clearInterval(t);
}
