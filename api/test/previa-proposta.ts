// Gera uma prévia da proposta com dados de exemplo: npx tsx test/previa-proposta.ts saida.pdf
import { writeFileSync } from 'node:fs';
import { gerarPdf, type DadosProposta } from '../src/orcamentos/proposta.js';

const exemplo: DadosProposta = {
  loja: { nome: 'DHC Persianas & Cortinas', cnpj: '64.656.181/0001-91', telefone: '(41) 98837-5657', email: 'dhc@dhcpersianas.com.br', instagram: '@dhcpersianas' },
  codigo: 'ORC-2026-1003', versao: 1, data: '26/11/2026', validadeAte: '11/12/2026', titulo: 'Apartamento 302', rascunho: false,
  cliente: { nome: 'Gabrielly', telefone: '(41) 99649-0200', endereco: 'Rua Rosamelia de Oliveira 666, Bloco 3 - Apto 4, Campo Comprido, Curitiba - PR' },
  vendedor: 'Gabriel',
  ambientes: [
    { nome: 'Escritório', subtotal: 'R$ 511,60', itens: [
      { titulo: 'Persiana Horizontal 25mm Lisa', medidas: '1,50 × 1,70 m (L × A)', icone: 'HORIZONTAL', pecas: 1, valor: 'R$ 511,60', garantia: '12 meses',
        detalhes: [{ rotulo: 'Acionamento', valor: 'Manual · comando à esquerda' }, { rotulo: 'Fixação', valor: 'No teto' }, { rotulo: 'Instalação', valor: 'Inclusa' }] },
    ] },
    { nome: 'Sala', subtotal: 'R$ 4.585,53', itens: [
      { titulo: 'Rolo Double Vision Slim Cream', medidas: '2,55 × 2,70 m (L × A)', icone: 'ROLO', pecas: 1, valor: 'R$ 1.957,50', garantia: '2 anos',
        detalhes: [{ rotulo: 'Acionamento', valor: 'Manual · comando à direita' }, { rotulo: 'Acabamento', valor: 'Bandô' }, { rotulo: 'Instalação', valor: 'Inclusa' }] },
      { titulo: 'Cortina Wave', medidas: '3,50 × 2,60 m (L × A)', icone: 'CORTINA', pecas: 1, valor: 'R$ 1.576,64', garantia: '',
        detalhes: [{ rotulo: 'Tecido', valor: 'Linho Rústico Areia' }, { rotulo: 'Forro', valor: 'Microfibra' }, { rotulo: 'Abertura', valor: 'Central (2 folhas)' }, { rotulo: 'Trilho / varão', valor: 'Trilho suíço duplo' }, { rotulo: 'Instalação', valor: 'Inclusa' }] },
      { titulo: 'Persiana Rolo Blackout', medidas: '2,50 × 2,20 m (L × A)', icone: 'ROLO', pecas: 2, valor: 'R$ 1.051,39', garantia: '2 anos; motor 5 anos',
        detalhes: [{ rotulo: 'Acionamento', valor: 'Motorizado' }, { rotulo: 'Instalação', valor: 'Inclusa' }] },
    ] },
  ],
  subtotal: 'R$ 5.097,13', desconto: '- R$ 97,13', acrescimo: null, total: 'R$ 5.000,00',
  condicoesPagamento: 'PIX. Ou no cartão de crédito em até 12x de R$ 458,33',
  prazoEntrega: '14 dias úteis (sem contar sábado e domingo) após a confirmação do pedido e da medição.',
  garantia: 'Contra defeitos de fabricação e instalação, no prazo indicado para cada item abaixo.',
  observacoes: null, avisoConferencia: true,
};

writeFileSync(process.argv[2] ?? 'previa-proposta.pdf', await gerarPdf(exemplo));
