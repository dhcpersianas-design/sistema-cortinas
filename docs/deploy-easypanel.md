# Deploy na VPS (Easypanel)

Referência técnica. O passo a passo para leigos está no guia entregue ao Gabriel.

## Arquitetura

```
Internet ──HTTPS──> Traefik (Easypanel) ──> serviço "sistema" (porta 3000)
                                               ├─ Next.js (site/PWA, porta 3000)
                                               └─ API Fastify (porta 3333, só interna)
                                                        │
                                               serviço "banco" (PostgreSQL 17, rede interna)
```

- **Uma imagem só** (`Dockerfile` na raiz) com API + site. O site repassa `/api/*` para a
  API em `127.0.0.1:3333`, então navegador e cookie de sessão ficam na mesma origem.
  `deploy/iniciar.mjs` sobe os dois; se um cair, o container sai e o Docker reinicia.
- **Banco:** serviço PostgreSQL nativo do Easypanel (imagem `postgres:17`). Sem porta pública.
- **HTTPS:** domínio configurado no Easypanel (Let's Encrypt automático). Obrigatório para o
  PWA/offline e para o cookie `Secure` (ligado com `NODE_ENV=production`).

## A cada início do container

`api/dist/scripts/preparar-producao.js`:
1. espera o banco aceitar conexão (até 60 s);
2. aplica as migrações pendentes de `api/db/migracoes` (inclui os dados base da `0002`);
3. `LOJA_NOME` (opcional) renomeia a loja;
4. se **não existe nenhum ADMIN ativo**, cria um com `ADMIN_EMAIL` / `ADMIN_NOME` /
   `ADMIN_SENHA_INICIAL`, com troca de senha obrigatória no 1º acesso. Se já existe, ignora
   (nunca redefine senha). O catálogo fictício de exemplo **não** é carregado em produção.

## Variáveis de ambiente (aba Environment do serviço)

| Variável | Obrigatória | Exemplo / padrão | Para quê |
|---|---|---|---|
| `DATABASE_URL` | sim | Internal Connection URL do serviço PostgreSQL | Conexão com o banco |
| `ADMIN_EMAIL` | 1ª vez | `voce@empresa.com.br` | E-mail do primeiro ADMIN |
| `ADMIN_NOME` | não | `Gabriel` | Nome do primeiro ADMIN |
| `ADMIN_SENHA_INICIAL` | 1ª vez | 8+ caracteres, letras e números | Senha provisória; pode apagar depois |
| `LOJA_NOME` | não | nome da empresa | Nome da loja |
| `SESSAO_DIAS` | não | `30` | Dias até a sessão expirar |
| `LIMITE_LOGIN_POR_MINUTO` | não | `10` | Proteção contra tentativa de senha |
| `BACKUP_MANTER` | não | `14` | Quantos backups diários manter |
| `BACKUP_HORA` | não | `3` | Hora (Brasília) a partir da qual roda o backup |

Já definidas na imagem: `NODE_ENV=production`, `TZ=America/Sao_Paulo`, `BACKUP_PASTA=/dados/backups`.

## Volume

Montar um **Volume** em `/dados` no serviço "sistema" (guarda os backups entre atualizações).

## Backup

- Todo dia, a partir de `BACKUP_HORA`, a API roda `pg_dump --format=custom` e grava
  `/dados/backups/cortinas-AAAA-MM-DD.dump`; mantém os `BACKUP_MANTER` mais recentes.
  Se o container estava parado no horário, faz assim que voltar.
- Tela **Backups** (só ADMIN): lista, "Fazer backup agora" e baixar. Recomendação: baixar 1×
  por semana e guardar fora da VPS (o volume fica no mesmo disco).
- `pg_dump` da imagem é o 17: funciona com PostgreSQL até 17. Se o banco for atualizado para 18,
  trocar `postgresql17-client` no `Dockerfile`.
- Camada extra opcional: aba Backups do próprio serviço PostgreSQL no Easypanel (para S3) e
  backup/snapshot da VPS no painel da Hostinger.

### Restaurar

Num banco vazio (ex.: serviço PostgreSQL novo), de um computador com o cliente do PostgreSQL 17:

```bash
pg_restore --no-owner --no-privileges --dbname "postgres://USUARIO:SENHA@HOST:5432/BANCO" cortinas-AAAA-MM-DD.dump
```

Ou pelo Console do serviço "sistema" no Easypanel, com o arquivo em `/dados/backups`:

```bash
pg_restore --no-owner --no-privileges --clean --if-exists --dbname "$DATABASE_URL" /dados/backups/cortinas-AAAA-MM-DD.dump
```

## Atualizar

Merge na `main` → no Easypanel, botão **Deploy** do serviço (ou ligar o deploy automático
pelo webhook do GitHub). As migrações novas rodam sozinhas no início.

## Recursos (KVM 1: 1 vCPU, 4 GB)

Estimativa (não medida na VPS): ~250 MB (Next + API) + ~100 MB (PostgreSQL). O build da imagem usa ~1,5 GB por
alguns minutos; evite fazer deploy em horário de uso intenso.
