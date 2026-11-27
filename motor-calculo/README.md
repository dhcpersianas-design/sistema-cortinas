# Motor de cálculo — cortinas e persianas sob medida

Pacote isolado (Node + TypeScript) que recebe medidas e acabamentos e devolve a
explosão de componentes (BOM) com quantidades, custo, venda, margem, alertas
técnicos e dados para a ficha de produção. Implementa as seções 2 a 6 da
*Especificação Técnica ERP Cortinas e Persianas* (v1.0).

- Aritmética 100% `decimal.js` (arredondamento HALF_UP). Nenhum `Number` toca em
  quantidade ou dinheiro. Entradas aceitam string (`"2.60"` ou `"2,60"`), número
  ou Decimal.
- Não acessa banco: recebe um `Catalogo` (interface `obter(sku)`). O seed da
  seção 7 vem pronto em `catalogoSeed`.
- Cada linha guarda o snapshot de custo/preço e um `formulaLog` legível.

## Uso

```bash
npm install
npm test        # 50 testes (vitest)
npm run build   # gera dist/
```

```ts
import { calcularCortina, calcularPersiana, catalogoSeed, paraJSON } from '@sistema/motor-calculo';

const cortina = calcularCortina({
  larguraTrilho: '3.00', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
  tecido: { sku: 'TEC-001', fator: '2.5' },
  forro:  { sku: 'TEC-002', fator: '2.0' },
  skus:   { trilho: 'TRI-002' },
  profundidadeCortineiroM: '0.20',
}, catalogoSeed);

const persiana = calcularPersiana({
  sku: 'PER-001',
  medida: { tipo: 'VAO_BRUTO', modo: 'DENTRO_VAO', largura: ['1.52', '1.50', '1.51'], altura: '1.60' },
  acionamento: 'MOTORIZADO', ladoComando: 'DIREITO', sentidoEnrolamento: 'NORMAL',
  possuiBando: true,
}, catalogoSeed);

paraJSON(cortina); // strings decimais prontas para API/banco
```

## Estrutura

| Arquivo | Conteúdo |
|---|---|
| `src/decimal.ts` | Instância Decimal, `ceilStep`, arredondamento de dinheiro, validação |
| `src/cortina.ts` | Seção 4.1: tecido/forro, sentido de corte (sem rapport), MDO, trilho/varão, deslizantes, fita, terminais, garras/suportes, instalação, alertas |
| `src/persiana.ts` | Seção 4.2: vão bruto → produção, área com mínimos, bando, guia, motor/controle/hub, redutor, divisão em peças, alertas |
| `src/orcamento.ts` | Soma de itens e margem consolidada; `paraJSON` |
| `src/catalogo-seed.ts` | 27 SKUs fictícios da seção 7/8 |
| `test/` | Casos 1 e 2 da seção 6 + bordas |

## Regras de arredondamento adotadas

| Grandeza | Regra |
|---|---|
| Tecido / forro / fita wave (ML) | CEIL ao múltiplo `arredondamentoML` (padrão 0,10) — da especificação |
| Trilho / varão (ML) | CEIL ao metro inteiro (barra), máx. 6,00 m por barra — decidido |
| Bando, guia (ML) | CEIL a 0,01 após aplicar o mínimo — confirmado |
| Área de persiana (M2) | ROUND HALF_UP a 4 casas — da especificação |
| UN / PC | Inteiros por CEIL (deslizante Wave: par por folha) — da especificação |
| Unitário (custo/preço, com multiplicador) | HALF_UP 4 casas (NUMERIC(12,4)) |
| Total da linha | qtd × unitário, HALF_UP 2 casas; total do item = soma das linhas — confirmado |
| Margem % | lucro ÷ venda × 100, HALF_UP 2 casas |

## Alertas

| Código | Severidade | Quando |
|---|---|---|
| `CORTE_EM_TIRAS` | INFO | H_corte > largura do rolo, ou tecido não permite virar a trama |
| `PE_DIREITO_ALTO` | ATENCAO | Altura pronta > 3,00 m (aplica `fator_pe_direito_alto` do SKU de MDO) |
| `TRILHO_ACIMA_BARRA_MAX` | ATENCAO | Trilho > 6,00 m (precisa de mais de uma barra) |
| `INSTALACAO_FAIXA` | ATENCAO | Trilho > 3,00 m com instalação "até 3,00 m" |
| `CORTINEIRO_RASO` | CRITICO | Wave simples < 15 cm; Wave c/ forro em trilho duplo < 18 cm |
| `CORTINEIRO_NO_LIMITE` | ATENCAO | Wave c/ forro entre 18 e 22 cm |
| `FORRO_SEM_VIA` | ATENCAO | Forro em trilho/varão de 1 via |
| `WAVE_EM_VARAO` | CRITICO | Confecção Wave em varão |
| `LARGURA_EXCEDE_ROLO` | CRITICO | Largura da peça > `larg_max` do SKU |
| `SUGERIR_REDUTOR_PESO` | ATENCAO | Manual com largura > 2,40 m (sugere ACP-003) |
| `RISCO_TELESCOPAGEM` | ATENCAO | H > 2,5 × L |

## Suposições (lacunas da especificação — confirmar com a loja)

- **S1 — Emenda de trilho. ✅ DECIDIDO (2026-11-27):** o motor NÃO calcula
  emenda. A barra é comprada no comprimento total do trilho; se for preciso
  dividir para instalar, quem decide é o instalador. O SKU FIX-003 continua no
  catálogo para inclusão manual.
- **S1a — Venda do trilho por barra. ✅ DECIDIDO (2026-11-27):** cobrado em
  metros inteiros, arredondando para cima (1,50 → 2 m; 2,20 → 3 m), barra
  máxima de 6,00 m (metadata `passo_venda_m` padrão 1,00 e `barra_max` padrão
  6,00). Garras, deslizantes e mão de obra usam a medida real do trilho.
- **S1b — Trilho acima de 6,00 m (suposição).** Cobra a soma das barras com o
  mesmo arredondamento ao metro (6,10 → 7 m) e gera o alerta
  `TRILHO_ACIMA_BARRA_MAX` com o número de barras; emenda não é incluída.
  Aplicado também ao varão.
- **S2 — Rapport. ✅ DECIDIDO (2026-11-27):** removido. Os tecidos da loja são
  quase sempre lisos; não há campo de rapport.
- **S3 — Arredondamento. ✅ CONFIRMADO (2026-11-27).** Ver tabela acima: ML de bando/guia sobe para
  o centímetro; dinheiro arredonda por linha antes de somar. Os dois casos da
  especificação batem nesse modelo.
- **S4 — Mão de obra base ML_TRILHO.** Quando escolhida, usa a medida real do
  trilho (com mínimo de 1,00 m), não a barra cobrada.
- **S5 — Vão bruto fora do vão/teto.** Com várias medidas, usa a menor também
  em FORA_VAO e TETO (a especificação só fala de DENTRO_VAO). FORA_VAO usa
  +0,25 m na altura (faixa 0,20–0,25); folgas são configuráveis.
- **S6 — Divisão do vão em peças.** Largura dividida igualmente (truncada ao
  mm); mínimos de fábrica, bando, motor e instalação valem por peça; controle
  remoto não multiplica.
- **S7 — Prega.** Prega usa deslizantes comuns (1 jogo por camada) e não usa
  fita Wave; não há SKU de fita de prega no catálogo.
- **S8 — Varão.** Usa o SKU de fixação como suporte (2 até 2,00 m; +1 por metro
  ou fração acima), sem FinalClick e sem deslizantes comuns (argolas não estão
  no catálogo).
- **S9 — Controle remoto/hub.** O motor sugere 1 controle por item motorizado;
  quem monta o orçamento passa `qtdControles: 0` nos demais itens do mesmo
  ambiente. Hub padrão 0.
- **S10 — Cortineiro.** Regra aplicada só para Wave (a especificação não traz
  profundidade para prega).

Fora do escopo deste pacote: persianas romana/horizontal/vertical (sem algoritmo
na especificação), descontos/taxas de cartão/semáforo de margem, persistência.
