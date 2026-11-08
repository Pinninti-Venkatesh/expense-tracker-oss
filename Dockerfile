# Build the React app in a throwaway stage so its dev dependencies (vite,
# plugins) never reach the runtime image.
FROM node:22-slim AS web-build
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY --from=web-build /web/dist ./web/dist

# Everything the install keeps: accounts, ledgers, settings made in the app and
# its own secrets. Mount a volume here (docker-compose.yml does), or on Cloud
# Run a storage bucket (scripts/deploy-cloud-run.sh does).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
ENV DATA_DIR=/data

# Cloud Run sets PORT; this default matches local dev.
ENV PORT=8080
ENV NODE_ENV=production
# Check everyone's email on a timer inside the server. On a host that sleeps,
# opening the app checks too, and catches up on anything missed.
ENV POLL_INTERVAL_MINUTES=10
EXPOSE 8080

# Don't run as root.
USER node

CMD ["node", "server/index.js"]
