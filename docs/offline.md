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
