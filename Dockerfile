# Playwright's official image: Chromium + all system deps preinstalled.
# Pinned to match the playwright npm package version in package.json.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY midasbuy-hybrid.js ./

ENV NODE_ENV=production
# Railway / Fly / Heroku set $PORT at runtime; the script reads it.

CMD ["node", "midasbuy-hybrid.js", "serve"]
