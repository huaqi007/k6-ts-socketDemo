# ============================================================================
# Dockerfile — 交易所压测工具一体化镜像（Node + k6 + 已编译 dist）
# ============================================================================
# 多阶段构建：
#   build 阶段：npm ci + webpack 打包 → 产出 dist/*.js
#   运行阶段：安装 k6 二进制 + 拷贝 dist/scripts，可同时充当「靶机」与「k6 执行器」
#
# 同一镜像被 docker-compose 里的 mock / mock-rl / k6 三个服务复用：
#   - mock / mock-rl 用 `node scripts/mock-server.js` 起靶机
#   - k6 用 `k6 run dist/xxx.js` 跑压测
# ============================================================================

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim
# k6 版本可通过 build-arg 覆盖；架构在构建期由 dpkg 探测，天然匹配镜像平台（amd64 / arm64），
# 无需依赖 buildkit 的 TARGETARCH，避免在非 buildkit 构建器下误装错架构而在模拟下崩溃。
ARG K6_VERSION=v2.1.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && ARCH="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-${ARCH}.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin "k6-${K6_VERSION}-linux-${ARCH}/k6" \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
# 默认作为靶机启动；k6 服务会覆盖为 `k6 run ...`
CMD ["node", "scripts/mock-server.js"]
