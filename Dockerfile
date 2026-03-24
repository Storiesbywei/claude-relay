FROM oven/bun:1.3-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package.json bun.lock bunfig.toml ./
COPY packages/shared/package.json packages/shared/
COPY packages/relay-server/package.json packages/relay-server/
COPY packages/mcp-server/package.json packages/mcp-server/

RUN bun install --frozen-lockfile

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/relay-server/ packages/relay-server/
COPY tsconfig.json ./

EXPOSE 4190

CMD ["bun", "run", "packages/relay-server/src/index.ts"]
