/** Endereço pelo CEP (ViaCEP, gratuito, especificação seção 10). Sem internet devolve null. */
export type EnderecoCep = { logradouro: string; bairro: string; cidade: string; uf: string };

export async function buscarCep(cep: string): Promise<EnderecoCep | null | 'nao_encontrado'> {
  const n = cep.replace(/\D/g, '');
  if (n.length !== 8) return null;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${n}/json/`);
    if (!r.ok) return null;
    const d = (await r.json()) as { erro?: boolean | string; logradouro?: string; bairro?: string; localidade?: string; uf?: string };
    if (d.erro) return 'nao_encontrado';
    return { logradouro: d.logradouro ?? '', bairro: d.bairro ?? '', cidade: d.localidade ?? '', uf: d.uf ?? '' };
  } catch {
    return null;
  }
}
