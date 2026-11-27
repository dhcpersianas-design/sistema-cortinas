# Uso offline na obra (arquitetura)

Requisito do Gabriel (27/11/2026), obrigatório no MVP (especificação v1.1, seção 12.5): o vendedor
precisa usar o sistema na obra mesmo sem internet.

## O que já está pronto (fundação)

- **PWA instalável** (`web/app/manifest.ts`): o vendedor adiciona à tela inicial do celular.
- **Service worker** (`web/public/sw.js`), ativo no build de produção:
  - arquivos do app ficam em cache;
  - telas já abertas com internet continuam abrindo sem conexão (senão aparece `/offline`);
  - o catálogo (`/api/catalogo/*`) fica guardado no aparelho.
- **Motor de cálculo no navegador**: `@sistema/motor-calculo/navegador` roda o mesmo cálculo
  da API sem servidor (o mesmo código, não uma cópia). Com o catálogo em cache, dá para
  calcular cortina e persiana na obra.
- **IDs gerados no aparelho**: as tabelas usam UUID, então registros criados offline já
  nascem com o ID definitivo, sem colisão na hora de sincronizar.
- **Sessão de 30 dias**: o vendedor não precisa logar de novo na obra.

## Clientes offline (pronto nos cadastros)

- Ao abrir **Clientes** com internet, o app baixa os clientes do vendedor (`GET /api/clientes/pacote-offline`)
  para o IndexedDB do aparelho (`web/lib/clientes-offline.ts`).
- Sem internet: busca sem acento no aparelho, ficha do cliente e cadastro/edição vão para uma fila local.
  A barra mostra "Sem internet" e "N alterações aguardando envio".
- Quando a conexão volta (evento `online` ou ao abrir a tela), a fila é enviada em ordem. O cadastro nasce
  com UUID gerado no aparelho, e o servidor não duplica se receber duas vezes.
- Edição carrega o `atualizadoEm` que o aparelho tinha; se o cliente mudou no servidor depois, a API
  responde 409 e **não sobrescreve**. O app guarda a versão do servidor e mostra a alteração recusada.
- O catálogo continua no cache do service worker; `/clientes` e `/catalogo` já ficam guardados na
  instalação do app, para abrir na obra mesmo sem visita anterior.
- Histórico de compras na ficha só aparece com internet.

## Orçamentos offline (pronto no configurador)

- Ao abrir **Orçamentos** com internet, o app envia o que estava pendente e baixa os orçamentos abertos do
  vendedor (`GET /api/orcamentos/pacote-offline`) para o IndexedDB (`web/lib/orcamentos-offline.ts`).
- Sem internet: criar orçamento, incluir/editar itens, ajustar componentes e mudar condições. O cálculo
  roda no aparelho com o mesmo motor da API e o catálogo em cache (marcado como "provisório"). Quem não
  vê custo calcula só o preço; o semáforo aparece depois de sincronizar.
- Cada gravação manda o orçamento inteiro (`PUT /api/orcamentos/:id`) com um `idOperacao`: reenviar não
  aplica duas vezes. O servidor recalcula, rateia e confere a margem, e avisa se o valor mudou.
- Conflito (o mesmo orçamento alterado em outro lugar) vira **nova versão**, nunca sobrescreve.
- Precisam de internet: liberar com a senha do ADMIN, enviar a proposta, gerar PDF e link do WhatsApp,
  e ver o histórico.

## Instalação e aceite offline (pronto no pedido)

- Ao abrir **Instalações** com internet, o app baixa as instalações agendadas do vendedor (de ontem até 30 dias:
  endereço, regras do condomínio, itens e peças, saldo a receber) para o IndexedDB (`web/lib/instalacoes-offline.ts`).
- Sem internet: abrir a instalação, conferir os itens e colher a assinatura do cliente com o dedo. O aceite fica no
  aparelho e é enviado sozinho quando a conexão volta (`POST /api/pedidos/:id/aceite`, id gerado no aparelho).
- Aditivo de medição usa o configurador de orçamento, que já funciona offline.
- Precisam de internet: aprovar o orçamento, confirmar aditivo, sinal, compras, agenda e os PDFs.

## Medição na obra (Agenda e medição, migração 0009)

- Ao abrir a Agenda com internet, o app baixa as visitas do usuário (de ontem até 30 dias, e as medidas
  ainda não conferidas) em `GET /api/medicoes/pacote-offline` (IndexedDB v4, store `medicoes`).
- Sem internet: abrir a visita, registrar os vãos (em centímetros, convertidos para metros) e tirar fotos.
  Os vãos ficam em `medicoesPendentes` e as fotos (reduzidas para até 1600 px, JPEG) em `fotosPendentes`;
  tudo é enviado sozinho quando a conexão volta. Ids gerados no aparelho: reenviar não duplica.
- Marcar, remarcar, cancelar e conferir também funcionam sem internet (decisão do Gabriel, 27/11/2026): vão para a
  fila `medicoesOps` e são enviados na ordem clientes novos -> visitas marcadas -> vãos -> fotos -> remarcar/cancelar/conferir.
- Conflitos: remarcação baseada numa cópia antiga é recusada pelo servidor (`atualizadoEmBase`) e o app avisa; conferir
  uma visita que outra pessoa já conferiu vira só aviso. A conferência feita sem internet leva a data do aparelho, e o
  prazo de entrega conta dessa data.
- Medidas: o campo aceita metros, centímetros ou milímetros e mostra como leu (2,595 / 259,5 / 2595 = 2,595 m; 260 = 2,60 m;
  inteiro de 1 a 9 = metros). Regras em `interpretarMedida` (web/lib/medicoes-offline.ts).

## Próximas etapas (com medição e orçamento, Fase 2)

0. **Pacote para o dia**: ao abrir com internet, o app baixa agenda do dia, clientes,
   orçamentos do vendedor e catálogo/preços vigentes.
1. **Fila local (IndexedDB)**: cada gravação feita offline (cliente, medição, fotos, item de
   orçamento, assinatura) vira uma operação na fila, com UUID próprio.
2. **Endpoint de sincronização** `POST /api/sync`: recebe as operações, aplica cada uma uma
   única vez (idempotente pelo UUID da operação) e devolve o que foi aceito ou recusado.
3. **Conflito** (regra da especificação v1.1): o mesmo orçamento editado em dois lugares vira
   **nova versão**, nunca sobrescrita silenciosa. O servidor detecta pelo `atualizado_em` que o
   aparelho tinha ao baixar.
4. **Recalcular no servidor**: o preço calculado offline é provisório; ao sincronizar, a API
   recalcula com o catálogo vigente e grava o snapshot oficial. Se mudar, o vendedor é avisado.
5. **Fotos**: guardadas no aparelho e enviadas em segundo plano quando a conexão voltar.
6. **Indicador de status** na barra: "offline", "N itens aguardando envio", "sincronizado".
