# React PWA built by Vite, served by nginx which also proxies /api to the API (same origin).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace shared --workspace frontend
COPY shared shared
COPY frontend frontend
RUN npm run build -w frontend

# unprivileged image: master and workers run as the nginx user, listening on 8080 (SEC-G5)
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY infra/nginx/security-headers.conf /etc/nginx/conf.d/security-headers.inc
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
