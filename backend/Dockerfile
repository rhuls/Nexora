FROM node:22-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json vitest.config.ts vitest.integration.config.ts ./
COPY src ./src
COPY tests ./tests
RUN npm run build

# Vitest writes a temp config bundle next to the config and a cache in node_modules/.vite; everything else stays root-owned.
RUN mkdir -p node_modules/.vite && chown node:node /app node_modules/.vite

ENV NODE_ENV=production
EXPOSE 4000
USER node

CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/server.js"]
