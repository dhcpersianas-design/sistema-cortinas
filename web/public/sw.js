// Service worker da fundação offline (ver docs/offline.md).
// - Arquivos estáticos do Next (_next/static): cache primeiro (têm hash no nome).
// - Páginas: rede primeiro; sem rede, a última versão guardada; senão /offline.
// - GET /api/catalogo/*: rede primeiro com cópia em cache, para calcular na obra.
// - Demais chamadas à API (login, gravações) nunca são cacheadas; gravações
//   offline vão para a fila local (IndexedDB) do app, não para o SW.
const VERSAO = 'v1';
const ESTATICO = `estatico-${VERSAO}`;
const PAGINAS = `paginas-${VERSAO}`;
const DADOS = `dados-${VERSAO}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(PAGINAS).then((c) => c.addAll(['/offline'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const atuais = [ESTATICO, PAGINAS, DADOS];
  e.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => !atuais.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function redePrimeiro(req, nomeCache, reserva) {
  const cache = await caches.open(nomeCache);
  try {
    const r = await fetch(req);
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch {
    return (await cache.match(req)) ?? (reserva ? cache.match(reserva) : Response.error());
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/_next/static/') || url.pathname === '/icone.svg') {
    e.respondWith(caches.open(ESTATICO).then(async (c) => (await c.match(req)) ?? fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  if (url.pathname.startsWith('/api/catalogo/')) {
    e.respondWith(redePrimeiro(req, DADOS));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(redePrimeiro(req, PAGINAS, '/offline'));
  }
});
