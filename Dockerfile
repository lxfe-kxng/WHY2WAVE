# TubeWave — Node.js/Express backend + yt-dlp + ffmpeg
FROM node:22-bookworm-slim

ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/yt-dlp /data/jobs \
 && case "$TARGETARCH" in arm64) YT=yt-dlp_linux_aarch64;; *) YT=yt-dlp_linux;; esac \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT" -o /opt/yt-dlp/yt-dlp \
 && chmod 755 /opt/yt-dlp/yt-dlp \
 && chown -R node:node /opt/yt-dlp /data

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY static ./static

ENV NODE_ENV=production \
    PORT=8000 \
    YTDLP_BIN=/opt/yt-dlp/yt-dlp \
    YTDLP_AUTO_UPDATE=1 \
    WAVEGRAB_JOBS=/data/jobs \
    TRUST_PROXY=1
USER node
EXPOSE 8000
CMD ["node", "server.js"]
