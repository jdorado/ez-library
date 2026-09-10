FROM rclone/rclone:1.74.2@sha256:9ce0d49b611d3781233e25334e9e23d7af01e5546da7087f90d55f034ef13637 AS sync-engine

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS test
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=sync-engine /usr/local/bin/rclone /usr/local/bin/rclone
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY scripts/publish-settings.mjs ./scripts/publish-settings.mjs
COPY test ./test
RUN node --test test/*.test.mjs

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates poppler-utils python3 make g++ cmake git openssh-client && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY --from=sync-engine /usr/local/bin/rclone /usr/local/bin/rclone
WORKDIR /app
COPY package.json ./
COPY docker/pnpm-lock.yaml ./pnpm-lock.yaml
COPY patches ./patches
RUN pnpm install --prod --frozen-lockfile
COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY docs/rclone-LICENSE.txt /usr/share/doc/rclone/copyright
RUN mkdir -p /state/qmd/cache/qmd/models /state/qmd/config/qmd && chown -R node:node /state && chmod 700 /state /state/qmd
ENV EZ_LIBRARY_STATE=/state
USER node
CMD ["node", "/app/src/sync-worker.mjs"]


FROM runtime AS embeddings
USER root
RUN mkdir -p /inference /models && chown -R node:node /inference /models && chmod 770 /inference /models
ENV QMD_FORCE_CPU=1 QMD_EMBED_PARALLELISM=1
USER node
CMD ["node", "/app/src/embedding-worker.mjs"]
