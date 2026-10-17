# Baileys NO usa navegador -> imagen minima, sin Chromium.
# Solo se necesita git porque Baileys instala libsignal desde GitHub.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

EXPOSE 4200
CMD ["node", "index.js"]
