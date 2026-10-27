# Compile platform-independent JS/web assets on the builder, not under QEMU.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN corepack pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md apps/web/public/licenses/
COPY LICENSES apps/web/public/licenses/LICENSES/
COPY docs/THIRD-PARTY-SOURCES.md apps/web/public/licenses/docs/THIRD-PARTY-SOURCES.md
RUN corepack pnpm --filter @moa/server build && corepack pnpm --filter @moa/web build

# Native runtime packages (notably sharp/libvips) must match the target CPU.
# Never copy the build-platform node_modules into the release image.
FROM node:22-bookworm-slim AS runtime-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN corepack pnpm --filter @moa/server... install --prod --frozen-lockfile

# Small native helper; no process runs until an administrator enables it.
FROM alpine:3.22 AS byedpi-build
RUN apk add --no-cache build-base linux-headers
ADD --checksum=sha256:c7211cfc0729d213219be9b67d774e375d75ae53bbf18b6af1967f06919bbac4 https://codeload.github.com/hufrea/byedpi/tar.gz/ba532298de7b28cfe854aea83d061369d13ca290 /tmp/byedpi.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/byedpi.tar.gz --strip-components=1 && make -j2 LDFLAGS=-static && strip ciadpi

FROM docker:28-cli AS docker-cli

FROM node:22-bookworm-slim AS runtime
# Jellyfin's own 7.x ffmpeg includes the Radeon VAAPI userspace drivers.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg \
    && printf '%s\n' 'deb [signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main' > /etc/apt/sources.list.d/jellyfin.list \
    && apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg7 libchromaprint-tools 7zip libarchive-tools util-linux python3 \
    && mkdir -p /data && chown node:node /data \
    && rm -rf /var/lib/apt/lists/*
# Platform-independent zipapp includes the matching EJS component; no runtime downloads.
RUN curl -fsSL --retry 2 --max-time 120 https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp -o /usr/local/bin/yt-dlp \
    && echo '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  /usr/local/bin/yt-dlp' | sha256sum -c - \
    && chmod 755 /usr/local/bin/yt-dlp && /usr/local/bin/yt-dlp --ignore-config --version
COPY --from=byedpi-build /src/ciadpi /usr/local/bin/ciadpi
COPY --from=byedpi-build /src/LICENSE /usr/local/share/licenses/byedpi/LICENSE
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY scripts/container-updater.mjs scripts/release.mjs scripts/update-files.mjs scripts/release-bundle.mjs scripts/update-launcher.mjs ./scripts/
COPY deploy/release-trust.json ./deploy/release-trust.json
COPY --from=runtime-deps /app/ ./
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/shared/src ./packages/shared/src
COPY --from=build /app/apps/web/dist ./web
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
COPY docs/THIRD-PARTY-SOURCES.md ./docs/THIRD-PARTY-SOURCES.md
ENV NODE_ENV=production MOA_DEPLOYMENT=docker MOA_DATA_DIR=/data MOA_MEDIA_ROOT=/media MOA_WEB_DIR=/app/web \
    MOA_FFMPEG=/usr/lib/jellyfin-ffmpeg/ffmpeg MOA_FFPROBE=/usr/lib/jellyfin-ffmpeg/ffprobe \
    MOA_7ZIP=/usr/bin/7zz MOA_SHORTS_EXTRACTOR=/usr/local/bin/yt-dlp MOA_BYEDPI_BINARY=/usr/local/bin/ciadpi \
    MOA_BYEDPI_BIND=0.0.0.0 MOA_BYEDPI_PROXY=socks5://moa:1080 LIBVA_DRIVERS_PATH=/usr/lib/jellyfin-ffmpeg/lib/dri
EXPOSE 8795
# Seed ownership for a fresh anonymous/named download volume.
RUN mkdir -p /downloads && chown node:node /downloads
USER node
# Exercise native sharp and resolve every server/workspace dependency on this CPU.
RUN cd apps/server && node --input-type=module -e "import sharp from 'sharp'; await sharp({create:{width:1,height:1,channels:3,background:'#000'}}).png().toBuffer(); await import('./dist/app.js'); console.log('Runtime modules verified on ' + process.arch)"
# Metadata changes must not invalidate package installation or runtime checks.
ARG MOA_REVISION=unknown
ARG MOA_VERSION=unknown
ARG MOA_REPOSITORY=sidetool/moa
LABEL org.opencontainers.image.version=$MOA_VERSION
LABEL org.opencontainers.image.revision=$MOA_REVISION
LABEL org.opencontainers.image.source=https://github.com/$MOA_REPOSITORY
ENV MOA_REVISION=$MOA_REVISION MOA_VERSION=$MOA_VERSION MOA_REPOSITORY=$MOA_REPOSITORY
CMD ["node", "apps/server/dist/index.js"]
