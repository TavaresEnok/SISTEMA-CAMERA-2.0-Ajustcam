# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm and openssl
# pnpm PINADO na versão que o repositório declara em package.json
# ("packageManager": "pnpm@9.15.0"). Sem a versão, o build instalava o pnpm
# mais novo do DIA: quando o pnpm 10 saiu, ele viu a divergência, tentou se
# auto-instalar via @pnpm/exe (que não está no lockfile) e o build morreu com
# "Cannot verify the identity of the @pnpm/exe.linux-x64 native binary".
# Ficou escondido por meses porque a camada estava em cache — só apareceu
# quando o cache foi limpo. Qualquer máquina nova ou CI já cairia nisso.
RUN npm install -g pnpm@9.15.0 && apk add --no-cache openssl git

# Copy workspace files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/

# Install dependencies
RUN pnpm install --prod=false

# Copy source
COPY apps/api ./apps/api

# Generate Prisma client
RUN pnpm --filter api prisma generate

# Build
RUN pnpm --filter api build

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app

# Install FFmpeg and OpenSSL
RUN apk add --no-cache ffmpeg openssl

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

USER node

EXPOSE 3000

CMD ["node", "apps/api/dist/main.js"]
