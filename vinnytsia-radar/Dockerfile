# Базовий образ з підтримкою компіляції нативних модулів (better-sqlite3)
FROM node:20-alpine AS builder

WORKDIR /app

# Встановлення інструментів компіляції для better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

# Фінальний легкозважений образ
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/radar.db

# Створення директорії для SQLite бази даних
RUN mkdir -p /app/data

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY . .

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "server.js"]
