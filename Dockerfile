# Token provider is private to this container; no extra paid service is needed.
FROM node:22-bookworm-slim AS provider
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch 2.0.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil
WORKDIR /opt/bgutil/server
RUN npm ci && npx tsc && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-venv tini \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.8.19' 'bgutil-ytdlp-pot-provider==2.0.2' \
    && mkdir -p /data/jobs && chown -R node:node /data
COPY --from=provider /opt/bgutil/server /opt/bgutil/server

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY scripts/start-container.js ./scripts/start-container.js
COPY static ./static

ENV NODE_ENV=production \
    PORT=8000 \
    YTDLP_BIN=/opt/yt-dlp/bin/yt-dlp \
    YTDLP_AUTO_UPDATE=0 \
    YTDLP_EXTRA_ARGS="--extractor-args youtube:player_client=mweb" \
    MAX_CONCURRENT=1 \
    MAX_DURATION_SEC=1200 \
    WAVEGRAB_JOBS=/data/jobs \
    TRUST_PROXY=1
USER node
EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/start-container.js"]
