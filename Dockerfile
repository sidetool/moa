# Compile platform-independent JS/web assets on the builder, not under QEMU.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/extensions/package.json packages/extensions/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/subtitles-ko/package.json packages/subtitles-ko/package.json
COPY packages/skip-markers/package.json packages/skip-markers/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN corepack pnpm install --frozen-lockfile
COPY packages/extensions packages/extensions
COPY packages/shared packages/shared
COPY packages/subtitles-ko packages/subtitles-ko
COPY packages/skip-markers packages/skip-markers
COPY apps/server apps/server
COPY apps/web apps/web
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md apps/web/public/licenses/
COPY LICENSES apps/web/public/licenses/LICENSES/
COPY docs/THIRD-PARTY-SOURCES.md apps/web/public/licenses/docs/THIRD-PARTY-SOURCES.md
RUN corepack pnpm --filter @moa/extensions build && corepack pnpm --filter @moa/subtitles-ko build && corepack pnpm --filter @moa/skip-markers build \
    && corepack pnpm --filter @moa/server build && corepack pnpm --filter @moa/web build

# Native runtime packages (notably sharp/libvips) must match the target CPU.
# Never copy the build-platform node_modules into the release image.
FROM node:22-bookworm-slim AS runtime-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/extensions/package.json packages/extensions/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/subtitles-ko/package.json packages/subtitles-ko/package.json
COPY packages/skip-markers/package.json packages/skip-markers/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN corepack pnpm --filter @moa/server... install --prod --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
# Jellyfin's own 7.x ffmpeg includes the Radeon VAAPI userspace drivers.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg \
    && printf '%s\n' 'deb [signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main' > /etc/apt/sources.list.d/jellyfin.list \
    && apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg7 libchromaprint-tools 7zip libarchive-tools util-linux \
    && mkdir -p /data && chown node:node /data \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=runtime-deps /app/ ./
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/extensions/dist ./packages/extensions/dist
COPY --from=build /app/packages/subtitles-ko/dist ./packages/subtitles-ko/dist
COPY --from=build /app/packages/skip-markers/dist ./packages/skip-markers/dist
COPY --from=build /app/packages/shared/src ./packages/shared/src
COPY --from=build /app/apps/web/dist ./web
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
COPY docs/THIRD-PARTY-SOURCES.md ./docs/THIRD-PARTY-SOURCES.md
ENV NODE_ENV=production MOA_DEPLOYMENT=docker MOA_DATA_DIR=/data MOA_MEDIA_ROOT=/media MOA_WEB_DIR=/app/web \
    MOA_FFMPEG=/usr/lib/jellyfin-ffmpeg/ffmpeg MOA_FFPROBE=/usr/lib/jellyfin-ffmpeg/ffprobe \
    MOA_7ZIP=/usr/bin/7zz LIBVA_DRIVERS_PATH=/usr/lib/jellyfin-ffmpeg/lib/dri
EXPOSE 8795
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
