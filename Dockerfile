FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++ git

# Copy package files
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for tsx)
RUN npm install --legacy-peer-deps && npx patch-package

# Copy source code and config
COPY tsconfig.json ./
COPY src/ ./src/
COPY patches/ ./patches/
COPY start.sh ./
RUN chmod +x start.sh

# Strip private RPC nodes (NodeReal API keys + QuickNode auth) from Docker image
RUN sed -i '/nodereal\.io/d; /quiknode\.pro/d' src/services/bsc-order-watcher.ts

# Create data directory
RUN mkdir -p /app/data

# Pre-bake market scan cache so first launch uses cache + background rescan
COPY polymarket-match-result.json ./

EXPOSE 3010

# Use tsx to run TypeScript directly (same as pm2 config)
CMD ["npx", "tsx", "src/dashboard/start-dashboard.ts", "--port", "3010", "--use-cache", "--rescan"]
