'use client';
import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { buscarCep } from '@/lib/viacep';

export const classeSelect = 'h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none transition-shadow focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 sm:h-10 sm:text-sm';
export const classeTextarea = 'min-h-20 w-full rounded-lg border border-input bg-card px-3 py-2 text-base outline-none transition-shadow focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 sm:text-sm';

type PropsCampo = React.InputHTMLAttributes<HTMLInputElement> & { rotulo: string; nome: string; dica?: string; largo?: boolean };

/** Rótulo + input, já com id/name. `largo` ocupa as 2 colunas no grid. */
export function Campo({ rotulo, nome, dica, largo, className, ...props }: PropsCampo) {
  return (
    <div className={cn('flex flex-col gap-1.5', largo && 'sm:col-span-2', className)}>
      <Label htmlFor={nome}>{rotulo}</Label>
      <Input id={nome} name={nome} {...props} />
      {dica && <span className="text-xs text-muted-foreground">{dica}</span>}
    </div>
  );
}

export function CampoTexto({ rotulo, nome, defaultValue }: { rotulo: string; nome: string; defaultValue?: string | null }) {
  return (
    <div className="flex flex-col gap-1.5 sm:col-span-2">
      <Label htmlFor={nome}>{rotulo}</Label>
      <textarea id={nome} name={nome} defaultValue={defaultValue ?? ''} className={classeTextarea} />
    </div>
  );
}

export type Endereco = { cep?: string | null; logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null };

/**
 * Bloco de endereço com preenchimento pelo CEP (ViaCEP). Sem internet, o
 * vendedor digita o endereço normalmente.
 */
export function CamposEndereco({ inicial }: { inicial?: Endereco }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);

  async function aoSairDoCep(e: React.FocusEvent<HTMLInputElement>) {
    const cep = e.currentTarget.value;
    if (cep.replace(/\D/g, '').length !== 8) return;
    setAviso('Buscando endereço…');
    const r = await buscarCep(cep);
    if (r === 'nao_encontrado') { setAviso('CEP não encontrado. Preencha o endereço.'); return; }
    if (!r) { setAviso('Não foi possível buscar o CEP agora (sem internet?). Preencha o endereço.'); return; }
    const raiz = ref.current!;
    const preencher = (n: string, v: string) => { const el = raiz.querySelector<HTMLInputElement>(`[name="${n}"]`); if (el && v) el.value = v; };
    preencher('logradouro', r.logradouro); preencher('bairro', r.bairro); preencher('cidade', r.cidade); preencher('uf', r.uf);
    setAviso(null);
    raiz.querySelector<HTMLInputElement>('[name="numero"]')?.focus();
  }

  return (
    <div ref={ref} className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
      <Campo rotulo="CEP" nome="cep" inputMode="numeric" autoComplete="postal-code" defaultValue={inicial?.cep ?? ''}
        onBlur={aoSairDoCep} dica={aviso ?? 'Preenche o endereço sozinho'} placeholder="00000-000" />
      <Campo rotulo="Rua / Avenida" nome="logradouro" defaultValue={inicial?.logradouro ?? ''} />
      <Campo rotulo="Número" nome="numero" defaultValue={inicial?.numero ?? ''} />
      <Campo rotulo="Complemento" nome="complemento" defaultValue={inicial?.complemento ?? ''} placeholder="Apto, bloco, casa" />
      <Campo rotulo="Bairro" nome="bairro" defaultValue={inicial?.bairro ?? ''} />
      <div className="grid grid-cols-[1fr_5rem] gap-3">
        <Campo rotulo="Cidade" nome="cidade" defaultValue={inicial?.cidade ?? ''} />
        <Campo rotulo="UF" nome="uf" maxLength={2} className="uppercase" defaultValue={inicial?.uf ?? ''} />
      </div>
    </div>
  );
}

/** FormData → objeto com strings (vazio vira "" para limpar no servidor). */
export function lerFormulario(form: HTMLFormElement, campos: string[]): Record<string, string> {
  const f = new FormData(form);
  return Object.fromEntries(campos.map((c) => [c, String(f.get(c) ?? '').trim()]));
}

export function Mensagens({ erro, ok, avisos }: { erro?: string | null; ok?: string | null; avisos?: string[] }) {
  return (
    <>
      {erro && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{erro}</p>}
      {ok && <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">{ok}</p>}
      {avisos?.map((a) => <p key={a} className="rounded-md border px-3 py-2 text-sm text-muted-foreground">{a}</p>)}
    </>
  );
}
