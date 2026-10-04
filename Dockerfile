# syntax=docker/dockerfile:1.7
# Ads MCP by: noti.vn — 1 image, nhiều entrypoint:
#   web     : node server.js            (Next.js standalone, mặc định)
#   worker  : node dist/worker.mjs      (pg-boss)
#   migrate : node dist/migrate.mjs     (chạy 1 lần trước web/worker)
#   cli     : node dist/cli.mjs <lệnh>  (create-admin, reset-password, reset-2fa, unlock, reencrypt)
#   updater : target riêng `updater` (node dist/updater.mjs) - dịch vụ cập nhật tự động, KHÔNG phải image web.
#             Là service duy nhất được mount docker.sock (xem docker-compose.yml, .claude/docs/07-deployment.md §6).
# Target mặc định (cuối file) là `runner` (web) nên `docker build .` / `build: .` không đổi hành vi.
# Build-arg APP_BUILD_VERSION (CI truyền từ tag v1.2.3 -> 1.2.3; mặc định "dev") là phiên bản HIỂN THỊ trong app,
# KHÁC biến compose APP_VERSION (chọn tag image để chạy).
# Config deploy (domain, secret…) đọc ở runtime từ biến môi trường — không bake vào image.

ARG NODE_IMAGE=node:24-slim
ARG UPDATER_NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# pnpm đúng version ghim trong package.json#packageManager (pnpm 11), tải 1 lần vào layer này
COPY package.json ./
RUN corepack enable && corepack install && pnpm --version

# ---------------------------------------------------------------------------
# deps: cài toàn bộ dependency (kể cả dev — cần cho next build + esbuild)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# ---------------------------------------------------------------------------
# builder: next build (output standalone) + bundle scripts/{migrate,worker,cli}.ts → dist/*.mjs
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN pnpm build \
 && test -f .next/standalone/server.js \
 && test -f dist/migrate.mjs && test -f dist/worker.mjs && test -f dist/cli.mjs && test -f dist/updater.mjs

# ---------------------------------------------------------------------------
# updater: daemon cập nhật tự động. Chạy root (bắt buộc để dùng docker.sock và ghi .env của thư mục dự án);
# giảm thiểu rủi ro bằng cấu hình service trong docker-compose.yml: không publish port, rootfs read-only,
# cap_drop ALL, no-new-privileges, không nhận kết nối vào, chỉ gọi docker bằng spawn(args[]) với giá trị đã kiểm tra.
# Cần: docker CLI + compose plugin. KHÔNG cần pg_dump (sao lưu chạy trong container db qua `docker compose exec`).
FROM ${UPDATER_NODE_IMAGE} AS updater
LABEL org.opencontainers.image.title="Ads MCP by: noti.vn - updater" \
      org.opencontainers.image.source="https://github.com/notivn/Ads-MCP-simple" \
      org.opencontainers.image.vendor="noti.vn" \
      org.opencontainers.image.licenses="LicenseRef-noti.vn-Proprietary"
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY --from=builder /app/dist/updater.mjs ./dist/updater.mjs
ARG APP_BUILD_VERSION=dev
ENV NODE_ENV=production \
    APP_BUILD_VERSION=${APP_BUILD_VERSION}
CMD ["node", "/app/dist/updater.mjs"]

# ---------------------------------------------------------------------------
# runner: chỉ chứa output đã build, chạy bằng user không phải root
FROM ${NODE_IMAGE} AS runner
LABEL org.opencontainers.image.title="Ads MCP by: noti.vn" \
      org.opencontainers.image.source="https://github.com/notivn/Ads-MCP-simple" \
      org.opencontainers.image.vendor="noti.vn" \
      org.opencontainers.image.licenses="LicenseRef-noti.vn-Proprietary"
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KEEP_ALIVE_TIMEOUT=130000 \
    NEXT_MANUAL_SIG_HANDLE=true
# Next standalone (dự án đơn, không monorepo): server.js nằm ở gốc .next/standalone,
# node_modules đã trace sẵn (cấu trúc .pnpm + symlink được giữ nguyên khi COPY).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
# Đặt cuối cùng để đổi phiên bản không làm mất cache các layer COPY ở trên
ARG APP_BUILD_VERSION=dev
ENV APP_BUILD_VERSION=${APP_BUILD_VERSION}
USER node
EXPOSE 3000
CMD ["node", "server.js"]
