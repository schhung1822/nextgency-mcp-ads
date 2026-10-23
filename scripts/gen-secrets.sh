#!/bin/sh
# Ads MCP by: noti.vn — tạo file .env với secret ngẫu nhiên (bản POSIX sh cho VPS).
# Cách chính: node scripts/gen-env.mjs. Script này chỉ là lớp bọc để chạy được khi máy chưa có Node:
#   1) có Node ≥ 20   → chạy node scripts/gen-env.mjs
#   2) có Docker      → chạy gen-env.mjs trong container node:24-slim (file .env vẫn thuộc user hiện tại)
#   3) chỉ có openssl → tự sinh bằng openssl (không hỗ trợ --dev)
#
# Dùng: sh scripts/gen-secrets.sh [--domain mcp.congty.vn] [--email it@congty.vn] [--ssl auto|cloudflare|nginx|tunnel]
#                                 [--force] [--print] [--dev] [--no-updater] [--app-version 1.0.2]
#   --print      : in nội dung .env ra màn hình thay vì ghi file
#   --no-updater : không bật cập nhật tự động (COMPOSE_PROFILES để trống)
#   --ssl        : phương án HTTPS (docs/deploy-vps.md), mặc định auto
#   --app-version: phiên bản image sẽ chạy (x.y.z); mặc định = package.json#version. Luôn được ghi vào .env.
# HOST_PROJECT_DIR (thư mục dự án trên máy chủ) = biến môi trường cùng tên hoặc thư mục hiện tại.
set -eu

cd "$(dirname "$0")/.."

has() { command -v "$1" >/dev/null 2>&1; }

if [ "${GEN_SECRETS_FALLBACK:-}" != "1" ]; then
  if has node && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then
    exec node scripts/gen-env.mjs "$@"
  fi
  if has docker && docker info >/dev/null 2>&1; then
    echo "Không thấy Node ≥ 20 — chạy gen-env.mjs trong Docker (node:24-slim)…" >&2
    # image ghim theo digest (giống FROM của Dockerfile) - script này sinh secret
    exec docker run --rm -e "HOST_PROJECT_DIR=${HOST_PROJECT_DIR:-$PWD}" --user "$(id -u):$(id -g)" -v "$PWD:/w" -w /w \
      node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 node scripts/gen-env.mjs "$@"
  fi
fi

# ---- Fallback thuần sh + openssl -------------------------------------------------------------
has openssl || { echo "Cần Node, Docker hoặc openssl để sinh secret." >&2; exit 1; }

domain="" email="" ssl=auto force=0 print=0 updater=1 app_version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) [ $# -ge 2 ] || { echo "Thiếu giá trị cho --domain" >&2; exit 1; }; domain=$2; shift 2 ;;
    --domain=*) domain=${1#*=}; shift ;;
    --email) [ $# -ge 2 ] || { echo "Thiếu giá trị cho --email" >&2; exit 1; }; email=$2; shift 2 ;;
    --email=*) email=${1#*=}; shift ;;
    --ssl) [ $# -ge 2 ] || { echo "Thiếu giá trị cho --ssl" >&2; exit 1; }; ssl=$2; shift 2 ;;
    --ssl=*) ssl=${1#*=}; shift ;;
    --app-version) [ $# -ge 2 ] || { echo "Thiếu giá trị cho --app-version" >&2; exit 1; }; app_version=${2#v}; shift 2 ;;
    --app-version=*) app_version=${1#*=}; app_version=${app_version#v}; shift ;;
    --force) force=1; shift ;;
    --print) print=1; shift ;;
    --no-updater) updater=0; shift ;;
    --dev) echo "--dev cần Node: node scripts/gen-env.mjs --dev" >&2; exit 1 ;;
    *) echo "Tham số không hợp lệ: $1" >&2; exit 1 ;;
  esac
done

[ -f .env.example ] || { echo "Không tìm thấy .env.example — chạy ở thư mục gốc dự án." >&2; exit 1; }
if [ "$print" -eq 0 ] && [ -f .env ] && [ "$force" -eq 0 ]; then
  echo ".env đã tồn tại. Dùng --force để ghi đè (nhớ giữ lại ENCRYPTION_KEYS cũ nếu đã có dữ liệu!)." >&2
  exit 1
fi

b64() { openssl rand -base64 "$1" | tr -d '\n'; }
b64url() { openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'; }

domain=$(printf '%s' "$domain" | sed -e 's#^https\{0,1\}://##' -e 's#/*$##' | tr 'A-Z' 'a-z')
pg=$(b64url 18)
export G_BETTER_AUTH_SECRET="$(b64 32)"
export G_ENCRYPTION_KEYS="1:$(b64 32)"
export G_MCP_KEY_PEPPER="$(b64 32)"
export G_SETUP_TOKEN="$(b64url 24)"
export G_POSTGRES_PASSWORD="$pg"
export G_DATABASE_URL="postgres://adsmcp:${pg}@db:5432/adsmcp"
if [ -n "$domain" ]; then
  export G_APP_DOMAIN="$domain"
  export G_BETTER_AUTH_URL="https://$domain"
fi
[ -n "$email" ] && export G_ACME_EMAIL="$email"
# --ssl -> biến của docker-compose.yml (giữ đồng bộ với SSL_PRESETS trong scripts/gen-env.mjs).
# Thứ tự: CADDY_REPLICAS CADDY_CLIENT_IP CADDY_TLS WEB_HOST_PORT CADDY_SITE_SCHEME CADDY_HTTP_PORT_BIND
#         CADDY_HTTPS_PORT_BIND CLOUDFLARED_REPLICAS
case "$ssl" in
  auto) set -- 1 direct auto "" "" 80 443 0 ;;
  cloudflare) set -- 1 cloudflare cloudflare-origin "" "" 80 443 0 ;;
  nginx) set -- 0 direct auto 3000 "" 80 443 0 ;;
  tunnel) set -- 1 tunnel tunnel "" "http://" "127.0.0.1:" "127.0.0.1:" 1 ;;
  *) echo "--ssl phải là một trong: auto, cloudflare, nginx, tunnel" >&2; exit 1 ;;
esac
export G_CADDY_REPLICAS="$1" G_CADDY_CLIENT_IP="$2" G_CADDY_TLS="$3" G_WEB_HOST_PORT="$4"
export G_CADDY_SITE_SCHEME="$5" G_CADDY_HTTP_PORT_BIND="$6" G_CADDY_HTTPS_PORT_BIND="$7" G_CLOUDFLARED_REPLICAS="$8"
# Tag image phát hành = --app-version hoặc package.json#version (chỉ nhận x.y.z). Không bao giờ để trống.
if [ -z "$app_version" ]; then
  app_version=$(sed -n 's/^  "version": "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)",*$/\1/p' package.json 2>/dev/null | head -n 1)
fi
if ! printf '%s' "$app_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Không xác định được phiên bản (APP_VERSION). Chạy lại với --app-version x.y.z (bản đã có trên trang Releases)." >&2
  exit 1
fi
export G_APP_VERSION="$app_version"
project_dir=${HOST_PROJECT_DIR:-$PWD}
project_dir=${project_dir%/}
export G_COMPOSE_PROFILES=""
if [ "$updater" -eq 1 ]; then export G_COMPOSE_PROFILES="updater"; fi
case "$project_dir" in
  /*[!A-Za-z0-9._/-]*|*..*) ;;
  /*) export G_HOST_PROJECT_DIR="$project_dir" ;;
esac

render() {
  awk '{
    sub(/\r$/, "")
    if (match($0, /^[A-Z0-9_]+=/)) {
      k = substr($0, 1, RLENGTH - 1)
      if (("G_" k) in ENVIRON) { print k "=" ENVIRON["G_" k]; next }
    }
    print
  }' .env.example
}

if [ "$print" -eq 1 ]; then
  render
else
  umask 077
  render > .env
  chmod 600 .env   # umask chỉ áp dụng khi tạo file mới (--force ghi đè file cũ)
  echo "Đã tạo .env. SETUP_TOKEN và các khoá nằm trong file này — hãy sao lưu ENCRYPTION_KEYS riêng." >&2
  [ -n "$domain" ] || echo "Nhớ sửa APP_DOMAIN, BETTER_AUTH_URL, ACME_EMAIL trong .env." >&2
  if [ "$ssl" = tunnel ]; then
    echo "Cloudflare Tunnel: dán token của tunnel vào dòng TUNNEL_TOKEN= trong .env (xem docs/deploy-vps.md, Phương án D)." >&2
  fi
fi
