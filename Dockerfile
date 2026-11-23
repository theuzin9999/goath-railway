# Imagem oficial do Playwright: já vem com Chromium e todas as libs do sistema.
# A versão da imagem TEM que ser igual à do "playwright" no package.json (1.40.0).
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

CMD ["node", "index.js"]
