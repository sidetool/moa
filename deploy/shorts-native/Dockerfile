# Optional local derivative only. Build the app from this experimental branch first.
ARG MOA_BASE_IMAGE=moa:shorts-native-base
FROM ${MOA_BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL --retry 2 --max-time 120 https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp -o /usr/local/bin/yt-dlp \
    && echo '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  /usr/local/bin/yt-dlp' | sha256sum -c - \
    && chmod 755 /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --ignore-config --version
ENV MOA_SHORTS_EXTRACTOR=/usr/local/bin/yt-dlp
USER node
