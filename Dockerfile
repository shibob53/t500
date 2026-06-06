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

# تم حذف سطر الـ VOLUME من هنا كما هو مطلوب من قبل Railway
RUN mkdir -p /app/.midasbuy-profile

ENV NODE_ENV=production

CMD ["node", "midasbuy-hybrid.js", "serve"]
