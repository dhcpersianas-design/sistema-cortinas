# Imagem única do sistema (API + app web) para o Easypanel.
# Expõe só a porta 3000 (o site). A API roda dentro, na 3333, e o site repassa /api para ela.

# ---------- build ----------
FROM node:22-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY motor-calculo/package.json motor-calculo/
COPY api/package.json api/
COPY web/package.json web/
# --ignore-scripts: o postinstall (build do motor) roda abaixo, já com o código copiado.
RUN npm ci --ignore-scripts
COPY . .
# O site repassa /api para a API dentro do mesmo container (fixado no build do Next).
ENV API_URL=http://127.0.0.1:3333 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- produção ----------
FROM node:22-alpine3.22
# pg_dump (backup) compatível com PostgreSQL até a versão 17; tzdata para o fuso.
RUN apk add --no-cache postgresql17-client tzdata
ENV NODE_ENV=production TZ=America/Sao_Paulo NEXT_TELEMETRY_DISABLED=1 \
    BACKUP_PASTA=/dados/backups
WORKDIR /app
COPY package.json package-lock.json ./
COPY motor-calculo/package.json motor-calculo/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/motor-calculo/dist motor-calculo/dist
COPY --from=build /app/motor-calculo/dados motor-calculo/dados
COPY --from=build /app/api/dist api/dist
COPY --from=build /app/api/db api/db
COPY --from=build /app/api/assets api/assets
COPY --from=build /app/web/.next web/.next
COPY --from=build /app/web/public web/public
COPY --from=build /app/web/next.config.ts web/
COPY deploy deploy
RUN mkdir -p /dados/backups && chown -R node:node /dados
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/saude || exit 1
CMD ["node", "deploy/iniciar.mjs"]
