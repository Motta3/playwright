FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
COPY package*.json ./
# Se o lock não está sincronizado, troque para: npm install --omit=dev
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# força o uso dos browsers embarcados na imagem oficial
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node","server.js"]