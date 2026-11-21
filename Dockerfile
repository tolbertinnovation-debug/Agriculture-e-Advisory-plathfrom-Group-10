# AgriConnect Liberia: one image with the API, the farmer app, the officer dashboard and the content.
# Build:  docker build -t agriconnect .
# Run:    see deploy/docker-compose.yml and docs/deploy.md
#
# Node 22 LTS (22.13 or newer is needed for the built-in SQLite). Rebuilding the image picks up
# Node security updates.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /srv/agriconnect

# Dependencies first, so code changes don't reinstall them.
COPY services/api/package.json services/api/package-lock.json services/api/
RUN cd services/api && npm ci --omit=dev && npm cache clean --force

COPY content ./content
COPY apps ./apps
COPY prototype ./prototype
COPY services/api/src services/api/src
COPY services/api/scripts services/api/scripts

# Data and backups live outside the image (volumes), owned by the unprivileged "node" user.
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node

ENV PORT=3000 \
    DB_PATH=/data/agriconnect.db \
    BACKUP_DIR=/backups \
    TRUST_PROXY=1
EXPOSE 3000

# Docker restarts the container if the server stops answering or loses its database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

WORKDIR /srv/agriconnect/services/api
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
