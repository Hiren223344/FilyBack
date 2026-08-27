# ==============================================================================
# Multi-stage Dockerfile for FilyBase GPU Inference Gateway
# Node.js 22 LTS on Alpine Linux
# ==============================================================================

# Stage 1: Build & TypeScript Compilation
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (e.g. argon2)
RUN apk add --no-cache python3 make g++

COPY package*.json tsconfig.json ./
RUN npm ci

COPY models.yaml ./
COPY src/ ./src/

RUN npm run build
RUN npm prune --production

# Stage 2: Production Runtime
FROM node:22-alpine AS runner

WORKDIR /app

# Add unprivileged user
RUN addgroup -S -g 10001 filybase && \
    adduser -S -u 10001 -G filybase filybase

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Copy node_modules and built dist
COPY --from=builder --chown=filybase:filybase /app/package*.json ./
COPY --from=builder --chown=filybase:filybase /app/node_modules ./node_modules
COPY --from=builder --chown=filybase:filybase /app/dist ./dist
COPY --from=builder --chown=filybase:filybase /app/models.yaml ./models.yaml
COPY --from=builder --chown=filybase:filybase /app/src/db/migrations ./dist/db/migrations
COPY --from=builder --chown=filybase:filybase /app/src/redis/lua ./dist/redis/lua

USER filybase

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "dist/index.js"]
