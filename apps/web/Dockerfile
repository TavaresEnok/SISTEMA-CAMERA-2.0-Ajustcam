# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
# pnpm PINADO na versão declarada em package.json — ver comentário longo em
# apps/api/Dockerfile. Sem versão, o build quebra sozinho quando o pnpm
# lança uma major nova.
RUN npm install -g pnpm@9.15.0

# Copy workspace files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/

# Pass VITE_API_URL as a build argument
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

# Install dependencies
RUN apk add --no-cache git
RUN pnpm install --prod=false

# Copy source
COPY apps/web ./apps/web

# Build
RUN pnpm --filter web build

# Production stage
FROM nginx:alpine AS runner

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Add custom nginx config for SPA routing
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
RUN chown -R nginx:nginx /var/cache/nginx /var/run /etc/nginx/conf.d

USER nginx

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
