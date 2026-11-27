// Ponto de entrada do container de produção (Easypanel).
// 1) prepara o banco (migrações + primeiro ADMIN); 2) sobe a API (porta interna 3333);
// 3) sobe o app web Next.js (porta 3000, a única exposta). Se um dos dois cair, o
// container sai e o Easypanel/Docker reinicia tudo.
import { spawn, spawnSync } from 'node:child_process';

const raiz = new URL('..', import.meta.url).pathname;
const env = { ...process.env, NODE_ENV: 'production', API_PORTA: '3333', API_URL: 'http://127.0.0.1:3333' };

const prep = spawnSync('node', ['api/dist/scripts/preparar-producao.js'], { cwd: raiz, env, stdio: 'inherit' });
if (prep.status !== 0) {
  console.error('Falha ao preparar o banco. Confira DATABASE_URL e se o serviço do PostgreSQL está rodando.');
  process.exit(1);
}

const filhos = [];
let saindo = false;
function subir(nome, args, cwd) {
  const p = spawn('node', args, { cwd, env, stdio: 'inherit' });
  p.on('exit', (codigo, sinal) => {
    if (saindo) return;
    console.error(`${nome} parou (código ${codigo ?? sinal}). Encerrando o container para reiniciar.`);
    encerrar(1);
  });
  filhos.push(p);
}
function encerrar(codigo) {
  saindo = true;
  for (const p of filhos) p.kill('SIGTERM');
  setTimeout(() => process.exit(codigo), 5000).unref();
  Promise.all(filhos.map((p) => new Promise((r) => (p.exitCode !== null ? r() : p.on('exit', r))))).then(() => process.exit(codigo));
}
process.on('SIGTERM', () => encerrar(0));
process.on('SIGINT', () => encerrar(0));

subir('API', ['dist/servidor.js'], `${raiz}api`);
// Espera a API responder antes de abrir o site.
for (let i = 0; i < 60; i++) {
  try { if ((await fetch('http://127.0.0.1:3333/api/saude')).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
subir('Web', [`${raiz}node_modules/next/dist/bin/next`, 'start', '--port', '3000', '--hostname', '0.0.0.0'], `${raiz}web`);
