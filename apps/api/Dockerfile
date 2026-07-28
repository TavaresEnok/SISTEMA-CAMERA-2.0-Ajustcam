# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm and openssl
RUN npm install -g pnpm && apk add --no-cache openssl git

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
