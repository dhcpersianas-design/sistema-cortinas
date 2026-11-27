'use client';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect } from '@/components/cadastro/campos';
import { chamar, type Item, type Orcamento } from '@/lib/orcamentos-offline';
import type { FotoInfo, Vao } from '@/lib/medicoes-offline';
import { resumoVao } from '../agenda/medicao';

type MedicaoObra = { id: string; numero: string; statusNome: string; dataRealizada: string; responsavelNome: string | null; obsCampo: string | null; vaos: Vao[]; fotos: FotoInfo[]; ligadaAoProjeto: boolean };

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Item do orçamento que corresponde ao vão: o mesmo item, ou mesmo ambiente + tipo (+ descrição, se houver). */
function itemSugerido(v: Vao, itens: Item[]): string {
  const porId = itens.find((i) => i.id === v.itemId);
  if (porId) return porId.id;
  const mesmos = itens.filter((i) => i.tipo === v.tipo && semAcento(i.ambiente) === semAcento(v.ambiente));
  const porDesc = mesmos.find((i) => v.descricao && semAcento(i.descricaoComercial).includes(semAcento(v.descricao)));
  return (porDesc ?? (mesmos.length === 1 ? mesmos[0] : undefined))?.id ?? '';
}

/** Passa a medida da obra para a entrada do item (o motor recalcula ao salvar; a descrição é refeita com a medida nova). */
function aplicarNoItem(item: Item, v: Vao): Item {
  const i = { ...item, descricaoComercial: '' };
  const e = i.entrada as Record<string, unknown>;
  if (i.tipo === 'PERSIANA') {
    const anterior = e.medida as { tipo?: string; folgas?: unknown } | undefined;
    const um = (xs: string[]) => (xs.length === 1 ? xs[0] : xs);
    return {
      ...i,
      entrada: {
        ...e,
        medida: { tipo: 'VAO_BRUTO', modo: v.modo ?? 'DENTRO_VAO', largura: um(v.larguras), altura: um(v.alturas), ...(anterior?.tipo === 'VAO_BRUTO' && anterior.folgas ? { folgas: anterior.folgas } : {}) },
        ...(v.ladoComando ? { ladoComando: v.ladoComando } : {}),
      },
    };
  }
  return {
    ...i,
    entrada: { ...e, larguraTrilho: v.larguras[0], alturaPronta: v.alturas[0], ...(v.profundidadeCortineiroM ? { profundidadeCortineiroM: v.profundidadeCortineiroM } : {}) },
  };
}

export function MedidasDaObra({ doc, editavel, onAplicar }: { doc: Orcamento; editavel: boolean; onAplicar: (itens: Item[], mensagem: string) => void }) {
  const [medicoes, setMedicoes] = useState<MedicaoObra[] | null>(null);
  const [escolha, setEscolha] = useState<Record<string, string>>({});
  const [aberto, setAberto] = useState(true);

  useEffect(() => {
    if (!doc.codigo) return; // orçamento ainda não enviado ao servidor
    chamar<{ medicoes: MedicaoObra[] }>(`/api/orcamentos/${doc.id}/medicoes`).then((r) => setMedicoes(r.medicoes)).catch(() => setMedicoes(null));
  }, [doc.id, doc.codigo]);

  const med = medicoes?.[0];
  const sugestoes = useMemo(() => Object.fromEntries((med?.vaos ?? []).map((v) => [v.id, itemSugerido(v, doc.itens)])), [med, doc.itens]);
  if (!med) return null;
  const alvo = (v: Vao) => escolha[v.id] ?? sugestoes[v.id] ?? '';

  function aplicar(lista: Vao[]) {
    let n = 0;
    const itens = doc.itens.map((i) => {
      const v = lista.find((x) => alvo(x) === i.id);
      if (!v || v.tipo !== i.tipo) return i;
      n++;
      return aplicarNoItem(i, v);
    });
    if (n) onAplicar(itens, `Medidas da obra aplicadas em ${n} item(ns). Confira os valores.`);
  }
  const ligados = med.vaos.filter((v) => alvo(v));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex-1">Medidas tiradas no local</CardTitle>
          <Button size="sm" variant="ghost" onClick={() => setAberto(!aberto)}>{aberto ? 'Ocultar' : 'Mostrar'}</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {med.numero} · {med.statusNome} · {new Date(med.dataRealizada).toLocaleDateString('pt-BR')}{med.responsavelNome ? ` · ${med.responsavelNome}` : ''}
          {' · '}<a className="underline" href={`/agenda?m=${med.id}`}>abrir medição</a>
        </p>
      </CardHeader>
      {aberto && (
        <CardContent className="space-y-3 text-sm">
          {med.vaos.map((v) => {
            const fotos = med.fotos.filter((f) => f.vaoId === v.id);
            return (
              <div key={v.id} className="space-y-1 border-t pt-2">
                <p><span className="font-medium">{v.ambiente}</span>{v.descricao ? `: ${v.descricao}` : ''} ({v.tipo === 'CORTINA' ? 'cortina' : 'persiana'})</p>
                <p>{resumoVao(v)}</p>
                {v.observacoes && <p className="text-muted-foreground">{v.observacoes}</p>}
                {fotos.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {fotos.map((f) => (
                      <a key={f.id} href={`/api/medicoes/fotos/${f.id}`} target="_blank" rel="noopener">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/medicoes/fotos/${f.id}`} alt={f.legenda ?? 'Foto do vão'} className="h-16 w-16 rounded border object-cover" loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
                {editavel && (
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label="Item do orçamento" className={`${classeSelect} sm:w-72`} value={alvo(v)} onChange={(e) => setEscolha({ ...escolha, [v.id]: e.target.value })}>
                      <option value="">Não aplicar</option>
                      {doc.itens.filter((i) => i.tipo === v.tipo).map((i) => <option key={i.id} value={i.id}>{i.ambiente}: {i.descricaoComercial}</option>)}
                    </select>
                    <Button size="sm" variant="outline" disabled={!alvo(v)} onClick={() => aplicar([v])}>Usar esta medida</Button>
                  </div>
                )}
              </div>
            );
          })}
          {med.obsCampo && <p className="border-t pt-2">Anotações da visita: {med.obsCampo}</p>}
          {editavel && ligados.length > 1 && <Button onClick={() => aplicar(ligados)}>Usar as {ligados.length} medidas nos itens</Button>}
          {!editavel && <p className="text-xs text-muted-foreground">Para usar estas medidas, crie uma nova versão (ou, no pedido, abra o aditivo).</p>}
        </CardContent>
      )}
    </Card>
  );
}
