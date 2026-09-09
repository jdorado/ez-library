FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS test
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY test ./test
RUN node --test test/*.test.mjs

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates poppler-utils python3 make g++ cmake git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app
COPY package.json ./
COPY docker/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --prod --frozen-lockfile
COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /state/qmd/cache/qmd/models /state/qmd/config/qmd && chown -R node:node /state && chmod 700 /state /state/qmd
ENV EZ_LIBRARY_STATE=/state
USER node
CMD ["node","--input-type=module","-e","process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},2147483647)"]
