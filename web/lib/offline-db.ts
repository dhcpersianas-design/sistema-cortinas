/**
 * IndexedDB mínimo (sem dependências) para o uso offline na obra (docs/offline.md).
 * Stores:
 *  - clientes: cópia local dos clientes do vendedor (pacote offline)
 *  - fila: gravações feitas sem internet, enviadas quando a conexão volta
 *  - meta: datas da última sincronização, avisos de conflito etc.
 *  - orcamentos: orçamentos do vendedor no aparelho (os com `pendente` ainda não foram enviados)
 *  - instalacoes: instalações agendadas do vendedor (pacote para a obra)
 *  - aceites: aceites assinados na obra ainda não enviados
 */
const NOME = 'sistema-cortinas';
const VERSAO = 3;
export type Store = 'clientes' | 'fila' | 'meta' | 'orcamentos' | 'instalacoes' | 'aceites';

let aberto: Promise<IDBDatabase> | null = null;

function abrir(): Promise<IDBDatabase> {
  if (aberto) return aberto;
  aberto = new Promise((ok, falha) => {
    const r = indexedDB.open(NOME, VERSAO);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('clientes')) db.createObjectStore('clientes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fila')) db.createObjectStore('fila', { keyPath: 'idOperacao' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('orcamentos')) db.createObjectStore('orcamentos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('instalacoes')) db.createObjectStore('instalacoes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('aceites')) db.createObjectStore('aceites', { keyPath: 'pedidoId' });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { aberto = null; falha(r.error); };
  });
  return aberto;
}

function pedido<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, falha) => { r.onsuccess = () => ok(r.result); r.onerror = () => falha(r.error); });
}

async function store(nome: Store, modo: IDBTransactionMode) {
  return (await abrir()).transaction(nome, modo).objectStore(nome);
}

export async function todos<T>(nome: Store): Promise<T[]> {
  return pedido((await store(nome, 'readonly')).getAll()) as Promise<T[]>;
}

export async function ler<T>(nome: Store, chave: IDBValidKey): Promise<T | undefined> {
  return pedido((await store(nome, 'readonly')).get(chave)) as Promise<T | undefined>;
}

export async function gravar(nome: Store, valor: unknown, chave?: IDBValidKey): Promise<void> {
  await pedido((await store(nome, 'readwrite')).put(valor, chave));
}

export async function apagar(nome: Store, chave: IDBValidKey): Promise<void> {
  await pedido((await store(nome, 'readwrite')).delete(chave));
}

/** Troca todo o conteúdo de um store (ex.: pacote de clientes baixado). */
export async function substituirTudo(nome: Store, valores: unknown[]): Promise<void> {
  const db = await abrir();
  await new Promise<void>((ok, falha) => {
    const tx = db.transaction(nome, 'readwrite');
    const s = tx.objectStore(nome);
    s.clear();
    for (const v of valores) s.put(v);
    tx.oncomplete = () => ok();
    tx.onerror = () => falha(tx.error);
  });
}
