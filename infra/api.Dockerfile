# NestJS API + worker (same image, different command). Build context: repo root.
FROM node:22.23.4-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace shared --workspace backend
COPY shared shared
COPY backend backend
RUN npm run build -w shared && npm run build -w backend

FROM node:22.23.4-alpine AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev --workspace shared --workspace backend && npm cache clean --force
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/backend/dist backend/dist
COPY backend/db backend/db
COPY backend/assets backend/assets
RUN mkdir -p /data/files && chown -R node:node /data
USER node
WORKDIR /app/backend
EXPOSE 3000
CMD ["node", "dist/main.js"]
