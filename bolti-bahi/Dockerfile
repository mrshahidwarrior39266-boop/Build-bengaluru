# Node 22 is required for the built-in node:sqlite module.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY package.json pnpm-lock.yaml* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# The ledger, store registry and transcript key live here, so a Railway volume
# mounted at /data keeps them across deploys.
ENV KHATA_DB=/data/bolti-bahi.db \
    STORE_DB=/data/stores.db \
    STORE_DATA_DIR=/data/stores
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]
