# syntax=docker/dockerfile:1

# Dokku builds this on the host from each pushed commit. On Heroku, buildpacks supplied Chrome and
# its fonts; here the image installs them. By hand: docker build -t url-to-pdf-api .
#
# No EXPOSE on purpose: Dokku publishes every exposed port on the host. Without one it proxies
# 80/443 to the container's 5000 and sets PORT, which src/config.js reads.

FROM docker.io/library/node:22-bookworm-slim

# google-chrome-stable brings every library Chrome links against, as the Heroku app's Chrome did.
# The fonts are what a page falls back to: Liberation is metric-compatible with Arial, Times New
# Roman and Courier New, so an uploaded form laid out in one of those keeps its line breaks.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y ca-certificates curl gnupg && \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update -qq && \
    apt-get install --no-install-recommends -y google-chrome-stable fonts-dejavu-core fonts-liberation fonts-noto-color-emoji && \
    apt-get purge -y gnupg && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

USER node
CMD ["node", "src/index.js"]
