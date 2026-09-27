FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build || true

ENV NODE_ENV=production
ENV PORT=5000

CMD ["node", "dist/index.js"]
