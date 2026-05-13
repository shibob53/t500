# Playwright's official image: Chromium + all system deps preinstalled.
# Pinned to match the playwright npm package version in package.json.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# Xvfb for virtual display (headed browser without real screen)
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY midasbuy-hybrid.js ./

# Persistent browser profile — mount a volume here to survive restarts
RUN mkdir -p /app/.midasbuy-profile
VOLUME /app/.midasbuy-profile

ENV NODE_ENV=production
# Railway / Fly / Heroku set $PORT at runtime; the script reads it.

CMD ["node", "midasbuy-hybrid.js", "serve"]
