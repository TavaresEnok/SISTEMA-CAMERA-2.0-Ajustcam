FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY apps/central/package.json ./package.json
# Instala dependências (ssh2 p/ instalação remota). --omit=optional evita o
# build nativo de cpu-features (opcional do ssh2) que não há toolchain p/ compilar.
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

COPY apps/central/src ./src
COPY apps/central/public ./public
COPY apps/central/scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 9765
CMD ["node", "src/server.js"]
