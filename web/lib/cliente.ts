/** Chamada à API a partir do navegador (passa pelo rewrite /api do Next). */
export async function api<T = unknown>(caminho: string, opcoes: { method?: string; corpo?: unknown } = {}): Promise<T> {
  const r = await fetch(caminho, {
    method: opcoes.method ?? 'GET',
    headers: opcoes.corpo !== undefined ? { 'content-type': 'application/json' } : {},
    body: opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined,
    credentials: 'same-origin',
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((dados as { erro?: string }).erro ?? `Erro ${r.status}`);
  return dados as T;
}
