FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY sdk/package.json ./sdk/
COPY contract/package.json ./contract/

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY . .

# Build SDK
RUN pnpm --filter pci-zkp-sdk build

# Production image
FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/sdk/dist ./sdk/dist
COPY --from=builder /app/sdk/package.json ./sdk/
COPY --from=builder /app/package.json ./

# Default port for ZKP service
EXPOSE 8084

CMD ["node", "sdk/dist/server.js"]
