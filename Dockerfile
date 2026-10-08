# syntax=docker/dockerfile:1.7
# Ads MCP by: noti.vn — 1 image, nhiều entrypoint:
#   web     : node server.js            (Next.js standalone, mặc định)
#   worker  : node dist/worker.mjs      (pg-boss)
#   migrate : node dist/migrate.mjs     (chạy 1 lần trước web/worker)
#   cli     : node dist/cli.mjs <lệnh>  (create-admin, reset-password, reset-2fa, unlock, unban, reencrypt, google:refresh-token)
#   updater : target riêng `updater` (node dist/updater.mjs) - dịch vụ cập nhật tự động, KHÔNG phải image web.
#             Là service duy nhất được mount docker.sock (xem docker-compose.yml, .claude/docs/07-deployment.md §6).
# Target mặc định (cuối file) là `runner` (web) nên `docker build .` / `build: .` không đổi hành vi.
# Build-arg APP_BUILD_VERSION (CI truyền từ tag v1.2.3 -> 1.2.3; mặc định "dev") là phiên bản HIỂN THỊ trong app,
# KHÁC biến compose APP_VERSION (chọn tag image để chạy).
# Config deploy (domain, secret…) đọc ở runtime từ biến môi trường — không bake vào image.
# Image nền ghim theo digest (FROM viết thẳng, không qua ARG, để Dependabot tự đề xuất bản vá):
#   node:24-slim (base/builder/runner) và node:24-alpine (updater) - đổi tag thì đổi luôn digest.

# ---------------------------------------------------------------------------
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base
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
# Chốt chặn thứ 2 (sau .dockerignore): Next chép .env* vào .next/standalone nếu có -> không bao giờ vào image.
RUN pnpm build \
 && test -f .next/standalone/server.js \
 && test -f dist/migrate.mjs && test -f dist/worker.mjs && test -f dist/cli.mjs && test -f dist/updater.mjs \
 && test -z "$(find .next/standalone -maxdepth 1 -name '.env*' -print -quit)"

# ---------------------------------------------------------------------------
# updater: daemon cập nhật tự động. Chạy root (bắt buộc để dùng docker.sock và ghi .env của thư mục dự án);
# giảm thiểu rủi ro bằng cấu hình service trong docker-compose.yml: không publish port, rootfs read-only,
# cap_drop ALL, no-new-privileges, không nhận kết nối vào, chỉ gọi docker bằng spawn(args[]) với giá trị đã kiểm tra.
# Cần: docker CLI + compose plugin + cosign (xác minh chữ ký số image trước khi cập nhật, 10-update-system.md).
# KHÔNG cần pg_dump (sao lưu chạy trong container db qua `docker compose exec`). Gỡ npm/yarn/corepack (không dùng).
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS updater
LABEL org.opencontainers.image.title="Ads MCP by: noti.vn - updater" \
      org.opencontainers.image.source="https://github.com/notivn/Ads-MCP-simple" \
      org.opencontainers.image.vendor="noti.vn" \
      org.opencontainers.image.licenses="LicenseRef-noti.vn-Proprietary"
# cosign phải là v3 (cùng đời với cosign v3.0.6 ký trong CI: định dạng bundle mới, chữ ký lưu kiểu OCI referrer).
# Kho Alpine đổi major -> build lỗi ngay thay vì phát hành updater không xác minh được chữ ký của CI.
RUN apk add --no-cache docker-cli docker-cli-compose "cosign<4" \
 && cosign version 2>&1 | grep -Eq 'GitVersion:[[:space:]]+v3\.' \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*
WORKDIR /app
COPY --from=builder /app/dist/updater.mjs ./dist/updater.mjs
ARG APP_BUILD_VERSION=dev
ENV NODE_ENV=production \
    APP_BUILD_VERSION=${APP_BUILD_VERSION}
CMD ["node", "/app/dist/updater.mjs"]

# ---------------------------------------------------------------------------
# runner: chỉ chứa output đã build, chạy bằng user không phải root. File của app thuộc root (tiến trình `node`
# không sửa được mã); chỗ ghi được duy nhất là /app/.next/cache (compose mới còn đặt rootfs read-only + tmpfs).
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runner
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
COPY --from=builder --chown=root:root /app/.next/standalone ./
COPY --from=builder --chown=root:root /app/.next/static ./.next/static
COPY --from=builder --chown=root:root /app/public ./public
COPY --from=builder --chown=root:root /app/dist ./dist
COPY --from=builder --chown=root:root /app/drizzle ./drizzle
# Cache của Next là chỗ ghi duy nhất (cả khi chạy bằng docker-compose.yml cũ, không read-only/tmpfs).
# Gỡ npm/npx/corepack/yarn: runtime chỉ cần `node`.
RUN mkdir -p /app/.next/cache && chown node:node /app/.next/cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*
# Đặt cuối cùng để đổi phiên bản không làm mất cache các layer COPY ở trên
ARG APP_BUILD_VERSION=dev
ENV APP_BUILD_VERSION=${APP_BUILD_VERSION}
USER node
EXPOSE 3000
CMD ["node", "server.js"]
