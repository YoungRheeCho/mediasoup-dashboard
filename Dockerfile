# mediasoup 대시보드 사이드카 이미지 (수집기 + 알림 + API + 화면)
#   docker build -t <registry>/mediasoup-dashboard:<tag> .
# 훅(hook/msdash-hook.cjs)은 이 이미지가 아니라 ConfigMap으로 mediasoup 서버 컨테이너에 들어간다 (deploy/k8s).

FROM node:22.22.0-slim AS build
WORKDIR /app

COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --no-audit --no-fund
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund

COPY server server
COPY web web
RUN cd server && npm run build && npm prune --omit=dev
RUN cd web && npm run build

FROM node:22.22.0-slim
WORKDIR /app
ENV NODE_ENV=production

# 경로 구성은 소스 트리와 같게 둔다 (설정 기본값이 dist/src 기준 ../../../db, ../../../web/dist)
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY db db

USER node
EXPOSE 18080
CMD ["node", "server/dist/src/index.js"]
