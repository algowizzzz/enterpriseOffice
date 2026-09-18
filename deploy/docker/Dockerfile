# Build stage. Runs on a machine with a registry mirror; the result needs none.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* ./
COPY packages/model/package.json packages/model/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && node scripts/check-no-remote-urls.mjs

# Runtime stage. No package manager, no node_modules, no network.
FROM node:22-bookworm-slim
RUN useradd --system --create-home --uid 10001 docforge
WORKDIR /opt/docforge
COPY --from=build /src/apps/server/dist/server.mjs ./server.mjs
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /var/lib/docforge && chown -R docforge:docforge /var/lib/docforge /opt/docforge
USER docforge
ENV NODE_ENV=production \
    DOCFORGE_HOST=0.0.0.0 \
    DOCFORGE_PORT=8080 \
    DOCFORGE_DB=/var/lib/docforge/docforge.db \
    DOCFORGE_WEB_ROOT=/opt/docforge/web
EXPOSE 8080
VOLUME ["/var/lib/docforge"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DOCFORGE_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "/opt/docforge/server.mjs"]
