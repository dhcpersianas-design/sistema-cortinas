import { ALTERACAO_EM_MASSA } from '@sistema/motor-calculo';

/**
 * Trava de segurança (Gabriel, 27/11/2026): alteração em massa (mais de 10 itens: markup,
 * importação de preços, desfazer importação...) só passa com a palavra ALTERAR digitada.
 * A tela abre a caixinha; aqui a API confere de novo.
 */
export function faltaConfirmacao(quantidade: number, confirmacao: unknown, limite: number = ALTERACAO_EM_MASSA.limite): boolean {
  if (quantidade <= limite) return false;
  return typeof confirmacao !== 'string' || confirmacao.trim().toUpperCase() !== ALTERACAO_EM_MASSA.palavra;
}

/** Resposta 428 padrão: a tela usa `precisaConfirmacao` para abrir a caixinha. */
export function respostaConfirmacao(quantidade: number) {
  return {
    erro: `Esta alteração muda ${quantidade} ${quantidade === 1 ? 'item' : 'itens'}. Para continuar, digite ${ALTERACAO_EM_MASSA.palavra} e clique em Continuar.`,
    precisaConfirmacao: true,
    quantidade,
  };
}
