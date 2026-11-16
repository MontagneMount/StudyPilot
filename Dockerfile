# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY server.js ./
COPY src ./src
COPY public ./public
COPY eval ./eval

# Ensure runtime directories exist with appropriate permissions
RUN mkdir -p /app/uploads /app/data && chown -R node:node /app

USER node

# Cloud Run injects PORT (defaults to 8080)
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
