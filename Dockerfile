# Abholbereit — Apple Store pickup alerts for Switzerland, as a container.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4321
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4321/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]
