# Triển khai (VPS + Docker Compose)

Mục tiêu: đơn vị được cấp quyền chạy được trên 1 VPS (Ubuntu 24.04 / Debian 12-13, ≥2 vCPU, ≥2 GB RAM, Docker + Compose plugin), domain trỏ **A record IPv4** (Claude connector chỉ hỗ trợ IPv4), bằng **image dựng sẵn trên GHCR** (riêng tư) - VPS không build.

**Hướng dẫn cho người vận hành (từng lệnh, 4 phương án đưa ra Internet: Caddy / Cloudflare proxy / Nginx / Cloudflare Tunnel): `docs/deploy-vps.md`.** Tài liệu này là phần kỹ thuật/thiết kế.

```bash
# Cài nhanh (khuyến nghị, VPS Ubuntu/Debian mới): sudo bash scripts/install-ads-mcp.sh - làm hết các bước dưới (docs/deploy-vps.md §0)
git clone https://github.com/notivn/Ads-MCP-simple.git /opt/ads-mcp && cd /opt/ads-mcp   # mật khẩu = token GitHub (PAT classic `repo` + `read:packages`)
docker login ghcr.io -u <user> --password-stdin                                         # cùng token
sh scripts/gen-secrets.sh --domain mcp.congty.vn --email it@congty.vn --ssl auto      # auto | cloudflare | nginx | tunnel
echo "UPDATER_DOCKER_CONFIG=$HOME/.docker" >> .env
docker compose pull && docker compose up -d --no-build                              # mở https://<APP_DOMAIN>/setup
```

### 0. Quyết định triển khai (1.0.0, 2026-10-03)
- **Không `build:` trong `docker-compose.yml`.** Đã kiểm thử (Compose v5.3): service có cả `build:` và `image:` thì `docker compose up` tự build khi kéo image bị từ chối, với **mọi** `pull_policy` (`missing`, `always`); chỉ `--no-build` chặn được. Hậu quả: PAT GHCR hết hạn + `up -d` = build Next.js trên VPS (lâu/hết RAM) và gắn nhãn phiên bản phát hành cho mã nguồn khác. `build:` chuyển sang `docker-compose.build.yml` (overlay cho máy dev/kiểm thử: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`).
- **Updater luôn gọi `docker compose -f docker-compose.yml`** (không đọc `docker-compose.override.yml`/`COMPOSE_FILE`). Mọi tuỳ biến triển khai phải là biến `.env` có mặc định trong `docker-compose.yml`, nếu không updater tạo lại `web` sai cấu hình sau mỗi lần cập nhật.
- **Chọn phương án SSL bằng biến** (gen-env `--ssl`): `CADDY_REPLICAS` (`deploy.replicas`, `0` = không chạy Caddy - phương án Nginx), `CADDY_CLIENT_IP` (`direct`|`cloudflare` → `deploy/caddy/client-ip-*.caddy`, import trong khối `servers`), `CADDY_TLS` (`auto`|`cloudflare-origin`|`cloudflare-origin-aop` → `deploy/caddy/tls-*.caddy`), `WEB_HOST_PORT` (web publish `127.0.0.1:${WEB_HOST_PORT:-}:3000`; trống = cổng ngẫu nhiên chỉ trên loopback, Nginx dùng `3000`). Không dùng profile cho Caddy: tài liệu cũ hướng dẫn xoá `COMPOSE_PROFILES` để tắt updater, dễ tắt nhầm luôn HTTPS. Phương án D (Cloudflare Tunnel, 2026-10-03) thêm: `CADDY_SITE_SCHEME` (trống = site HTTPS như cũ; `http://` = site `http://APP_DOMAIN` chỉ HTTP, không ACME), `CADDY_HTTP_PORT_BIND`/`CADDY_HTTPS_PORT_BIND` (ports `"${..:-80}:80"`, `"${..:-443}:443"`, `/udp`; mặc định giống hệt `80:80`/`443:443`; D đặt `127.0.0.1:` = loopback, cổng ngẫu nhiên), `CLOUDFLARED_REPLICAS` (`deploy.replicas` của service `cloudflared`, mặc định `0`), `TUNNEL_TOKEN`, `CLOUDFLARED_PROTOCOL`. Cùng lý do trên, cloudflared bật bằng replicas chứ không bằng profile.
- **Phương án D - Cloudflare Tunnel**: đường đi `Cloudflare edge ══ tunnel ══ cloudflared (container) ─HTTP─► caddy:80 ─► web:3000`. Giữ Caddy thay vì trỏ tunnel thẳng `web:3000` vì: (1) Cloudflare **giữ nguyên** `X-Forwarded-For` khách gửi và chỉ nối thêm (developers.cloudflare.com "Cloudflare HTTP headers"), cloudflared không sửa XFF (mã nguồn `proxy/proxy.go`) nên app (tin hop đầu) sẽ nhận IP giả; Caddy `client-ip-tunnel.caddy` = `trusted_proxies static private_ranges` + `client_ip_headers CF-Connecting-IP` rồi ghi đè XFF; (2) dùng lại che key MCP trong log, header bảo mật, body 1 MB, `flush_interval -1` cho SSE. An toàn của `private_ranges` dựa trên việc Caddy **không** nhận kết nối từ Internet ở D (ports chỉ `127.0.0.1`): nếu publish ra mọi địa chỉ, khách IPv6 qua docker-proxy mang IP gateway Docker (mạng riêng) sẽ tự khai được `CF-Connecting-IP`. Không ghim subnet mạng Docker để thu hẹp trusted_proxies vì đổi IPAM của mạng `default` buộc tạo lại mạng ở mọi bản cài cũ (A/B/C). Host: cloudflared giữ `Host` = hostname public khi route không đặt *HTTP Host Header* (mã nguồn `ingress/origin_proxy.go`), khớp site `http://APP_DOMAIN` và kiểm tra Host của MCP. `tls-tunnel.caddy` chuyển hướng 308 sang HTTPS khi `X-Forwarded-Proto: http` (Cloudflare luôn ghi đè header này bằng giao thức thật của khách). Service `cloudflared`: image `cloudflare/cloudflared:2026.9.3` (distroless, user 65532, ENTRYPOINT `cloudflared --no-autoupdate`), `tunnel --no-autoupdate --metrics 127.0.0.1:20241 run`, token qua env `TUNNEL_TOKEN` (chỉ biến này, không `env_file`), healthcheck `cloudflared tunnel --metrics 127.0.0.1:20241 ready` (lệnh có từ 2024.11.1; `/ready` = 200 khi có kết nối), `read_only`, `cap_drop: ALL`, `no-new-privileges`, `stop_grace_period: 35s` (> `--grace-period` 30 s), không publish cổng. Không bao giờ dùng `--loglevel debug` (ghi URL + header, lộ `/mcp/<key>`). Updater không đụng caddy/cloudflared (`up -d --no-deps web worker`). Đã kiểm thử: `docker compose config` A/B/C (env cũ và env mới sinh) chỉ khác ở service `cloudflared` (`replicas: 0`) + biến rỗng `CADDY_SITE_SCHEME`; `caddy adapt` A/B/B-aop giống hệt byte với Caddyfile cũ; Caddy thật ở chế độ tunnel: peer mạng riêng gửi `CF-Connecting-IP: 1.2.3.4` + `X-Forwarded-For: 6.6.6.6, ...` → upstream nhận `X-Forwarded-For: 1.2.3.4`, `X-Forwarded-Proto: https` giữ nguyên; peer dải `203.0.113.0/24` (ngoài private_ranges) → bỏ qua `CF-Connecting-IP`; cloudflared chạy với cờ hardening + token giả tới bước đăng ký (prechecks đạt, `Failed to get tunnel`), healthcheck trả mã 1 khi chưa có kết nối, token không xuất hiện trong log. **Chưa** kiểm chứng với tunnel/token thật. Hướng dẫn: `docs/deploy-vps.md` §10b.
- **IP thật**: Caddyfile đặt `header_up X-Forwarded-For {client_ip}` ở cả 2 `reverse_proxy` (user header ops áp dụng sau mặc định của Caddy nên ghi đè được). Mặc định (không trusted_proxies) `{client_ip}` = IP kết nối - giống hành vi cũ. Phương án Cloudflare: `trusted_proxies static <dải CF>` + `client_ip_headers CF-Connecting-IP` (Cloudflare giữ nguyên XFF khách gửi và nối thêm bên phải, nên không được dùng XFF mặc định). Nginx: `proxy_set_header X-Forwarded-For $remote_addr` (ghi đè, không `$proxy_add_x_forwarded_for`), sau Cloudflare thêm realip `CF-Connecting-IP`.
- `APP_VERSION` được gen-env ghim theo `package.json#version` lúc cài.

### 0b. Quyết định bảo mật triển khai (2026-10-05)
- **Cập nhật 2026-10-09 (chủ dự án quyết định): 1 token + script cài nhanh.** Khách dùng **một** PAT classic tích `repo` + `read:packages` cho cả `git clone/pull`, `docker login ghcr.io` (updater dùng chung) và `UPDATE_GITHUB_TOKEN`; khuyến nghị tài khoản GitHub riêng cho máy chủ vẫn giữ. Bản cài 2 token (bên dưới) vẫn chạy, không bắt buộc đổi. `scripts/install-ads-mcp.sh` (gửi riêng cho khách, chạy `sudo bash`, đọc câu trả lời từ `/dev/tty` nên chạy được cả khi pipe): kiểm tra máy/OS, token (401, đúng tài khoản, scope `X-OAuth-Scopes`, hạn `GitHub-Authentication-Token-Expiration`, quyền repo + tự chấp nhận lời mời), DNS/cổng, swap, UFW, Docker từ kho apt chính thức, `git clone --depth 1 --branch v<bản mới nhất>` (token qua `GIT_ASKPASS` + biến môi trường, không vào argv/`.git/config`/log), `docker login` bằng root (`/root/.docker`), `.env` bằng `gen-secrets.sh` (nhánh openssl) + `UPDATE_REPO`/`UPDATE_GITHUB_TOKEN`/`TUNNEL_TOKEN` (ghi bằng bash thuần), `compose pull/up`, chờ healthy, cài `/usr/local/bin/ads-mcp` (`status|logs|doctor|setup-key|token|update|update-config|backup|version`), màn hình cuối có mã cài đặt. Chạy lại khi đã có `.env` = chế độ sửa chữa (không sinh lại secret). Thư mục cài bằng script ở **tag cố định** (detached): cấu hình triển khai lấy theo `APP_VERSION` bằng `ads-mcp update-config`, không `git pull`. Nhật ký `/var/log/ads-mcp-install.log` (600, không chứa secret). Hướng dẫn: `docs/deploy-vps.md` §0.
- **Quyền GitHub của khách** (chủ dự án quyết định 2026-10-05, thay bằng 1 token ở mục trên): noti.vn thêm tài khoản GitHub của từng khách làm *outside collaborator* quyền **Read**. PAT fine-grained không dùng được cho outside collaborator và GHCR chỉ nhận PAT classic, nên khách dùng 2 PAT classic: **Token A** `read:packages` (`docker login ghcr.io`, updater dùng) và **Token B** `repo` (`UPDATE_GITHUB_TOKEN` cho web/worker + mật khẩu HTTPS khi `git clone/pull`, không lưu bằng `credential.helper store`). Tài khoản chỉ có Read nên token lộ không đẩy được mã/tag. Scope `repo` vẫn ghi được mọi repo khác của tài khoản đó: README khuyến nghị tài khoản riêng cho máy chủ (tuỳ chọn). Deploy key chỉ còn là tuỳ chọn nâng cao (`docs/deploy-vps.md` §5.3).
- **Chữ ký số image**: `docker.yml` ký cả 2 image (digest index multi-arch) bằng cosign keyless (OIDC GitHub Actions), danh tính `https://github.com/notivn/Ads-MCP-simple/.github/workflows/docker.yml@refs/tags/vX.Y.Z`. Updater (image có `cosign` từ Alpine) xác minh **đúng tag đích** sau bước kiểm `APP_BUILD_VERSION` (vẫn là step `pull`) và với image updater mới trước khi tự thay; chỉ khi `APP_IMAGE` là image mặc định và `.env` không có `UPDATER_VERIFY_SIGNATURE=0`. Lỗi/không kết nối được Sigstore = dừng (fail closed), bản đang chạy không bị ảnh hưởng. `TUF_ROOT=/tmp/sigstore-tuf` (tmpfs có sẵn ở mọi phiên bản compose). Bản updater cũ (chưa có cosign) vẫn cập nhật được lên bản mới; từ bản updater có cosign trở đi mọi bản đích đều phải có chữ ký. Không ghim digest trong compose (`APP_IMAGE_DIGEST`): updater cũ và hướng dẫn `sed APP_VERSION` không cập nhật được biến đó.
- **Bỏ `:latest`**: `image: ...:${APP_VERSION:?…}` cho app và updater; CI đặt `flavor: latest=false`. `gen-env.mjs`/`gen-secrets.sh` luôn ghi `APP_VERSION` (production lấy `package.json#version` hoặc `--app-version`, dev ghi `dev`), thiếu thì dừng. `.env` cũ để trống `APP_VERSION` thì mọi lệnh compose báo lỗi rõ ràng (không dừng container đang chạy).
- **Biến môi trường theo danh sách** (bỏ `env_file: .env`): `x-env-runtime` (web + worker), `x-env-web` (+ `APP_DOMAIN`, `BETTER_AUTH_*`, `MCP_KEY_PEPPER`, `SETUP_TOKEN`, `KEEP_ALIVE_TIMEOUT`), migrate chỉ `DATABASE_URL`/`MIGRATIONS_DIR`/`NODE_OPTIONS`. Mục dạng `TÊN:` không giá trị: Compose lấy từ shell rồi `.env`, không có thì biến **vắng mặt** (giữ nghĩa "chưa đặt"; **không** dùng `${VAR:-}` vì chuỗi rỗng khác chưa đặt, vd `LOG_RETENTION_MONTHS` rỗng làm app không khởi động, `SYSTEM_NOTICES_URL` rỗng = tắt). Đã kiểm `docker compose config`: biến chưa đặt hiện `null`. Worker không còn nhận `BETTER_AUTH_SECRET`/`MCP_KEY_PEPPER`/`SETUP_TOKEN` (bundle `dist/worker.mjs` không đọc chúng). `NODE_ENV`/`PORT`/`HOSTNAME`/`APP_BUILD_VERSION` của image không bị `.env` ghi đè. App đọc biến mới thì **phải** thêm vào danh sách.
- **Hardening container**: web/worker/migrate `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp` (web thêm tmpfs `/app/.next/cache` uid 1000), `mem_limit`/`pids_limit` qua biến `*_MEM_LIMIT`/`*_PIDS_LIMIT`; image runner: file app thuộc root, chỉ `/app/.next/cache` thuộc `node`, gỡ npm/npx/corepack/yarn (cả image updater). caddy: `read_only`, `cap_drop: ALL` + `NET_BIND_SERVICE`; backup: hardening + `DAC_OVERRIDE` (root ghi `./backups` của `deploy` quyền 700); db: chỉ `no-new-privileges` (entrypoint cần chown + gosu).
- **Mạng**: giữ mạng `default` có sẵn (db, migrate, web, worker, backup, updater) và thêm `edge` (caddy, cloudflared, web): thành phần nhận kết nối từ Internet không thấy `db`. **Không** chuyển db sang mạng `internal` mới: nếu người vận hành `git pull` mà chưa `up -d` rồi bấm Cập nhật, updater cũ chạy `compose run migrate`/`up web worker` theo file mới, db bị tạo lại sang mạng mới trong khi caddy, backup và chính updater cũ còn ở mạng `default` -> mất kết nối DB/502. Giữ `default` thì mọi tổ hợp cũ/mới vẫn thông. Đổi lại db/migrate/backup vẫn có đường ra Internet (như trước). Không ghim subnet.
- **Ghim image theo digest**: `FROM` trong Dockerfile viết thẳng `node:24-slim@sha256:…`/`node:24-alpine@sha256:…` (không qua ARG để Dependabot đọc được); postgres, caddy, cloudflared trong compose + CI cũng ghim digest. Bản vá OS của image nền chỉ tới qua PR Dependabot + bản phát hành mới.

## 1. Biến môi trường (`.env.example`)
| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `APP_DOMAIN` | ✔ | vd `mcp.example.com` (Caddy xin cert Let's Encrypt; dùng cho kiểm tra Host của MCP) |
| `ACME_EMAIL` | ✔ | email Let's Encrypt |
| `BETTER_AUTH_URL` | ✔ | `https://${APP_DOMAIN}` — production bắt buộc https (app từ chối khởi động nếu là http, trừ localhost) |
| `POSTGRES_PASSWORD` | ✔ | |
| `DATABASE_URL` | ✔ | `postgres://adsmcp:${POSTGRES_PASSWORD}@db:5432/adsmcp` |
| `BETTER_AUTH_SECRET` | ✔ | `openssl rand -base64 32` |
| `ENCRYPTION_KEYS` | ✔ | `1:<openssl rand -base64 32>` — **sao lưu riêng, mất là mất toàn bộ credential** |
| `MCP_KEY_PEPPER` | ✔ | `openssl rand -base64 32` — đổi = mọi link MCP chết |
| `SETUP_TOKEN` | ✔ (lần đầu) | chuỗi ngẫu nhiên **≥ 24 ký tự** để mở `/setup` (10 lần thử/15 phút/IP); vô hiệu khi đã có user |
| `LOG_RETENTION_MONTHS` | — | mặc định 3 (giá trị khởi tạo; sau đó chỉnh trong Cài đặt) |
| `APP_TIMEZONE` | — | mặc định `Asia/Ho_Chi_Minh` (hiển thị + lịch job) |
| `META_API_VERSION` / `GOOGLE_ADS_API_VERSION` / `TIKTOK_API_VERSION` / `OPENAI_ADS_API_VERSION` | — | mặc định `v26.0` / `v25` (Google hỗ trợ tới ~08/2027) / `v1.3` (bản TikTok duy nhất) / `v1`. Phải có trong `x-env-runtime` (web + worker) |
| `TIKTOK_BASE_URL` | — | mặc định `https://business-api.tiktok.com/open_api`; chỉ đặt để trỏ sandbox `https://sandbox-ads.tiktok.com/open_api` (chỉ nhận https). `x-env-runtime` |
| `TELEGRAM_API_BASE_URL` | — | mặc định `https://api.telegram.org`; chỉ đổi khi dùng Bot API server riêng (phải https, trừ localhost). `x-env-runtime` — worker gửi tin, web gửi tin thử / tool `telegram_send_message` (14-telegram-notifications.md §3) |
| `GOOGLE_ADS_CLIENT_SECRET` | — | **chỉ** cho lệnh CLI `google:refresh-token` (truyền `-e GOOGLE_ADS_CLIENT_SECRET` không kèm giá trị khi `docker compose run`); app không đọc biến này, không thêm vào danh sách compose |
| `KEEP_ALIVE_TIMEOUT` | — | `130000` (> keepalive 2 phút của Caddy) |
| `COMPOSE_PROFILES` | - | `updater` = bật service cập nhật tự động (gen-env ghi sẵn); để trống = tắt. Chỉ compose đọc |
| `HOST_PROJECT_DIR` | khi bật updater | đường dẫn tuyệt đối thư mục dự án **trên máy chủ** (gen-env tự điền; trống → `$PWD`). Xem §6.3 |
| `APP_VERSION` | ✔ | tag image đang chạy (`1.2.3`, không `v`; dev `dev`). **Updater tự ghi**; trống = mọi lệnh compose báo lỗi (không còn `latest`). KHÁC `APP_BUILD_VERSION` (ENV bake lúc build, là số hiển thị trong web) |
| `APP_IMAGE` | - | repo image không kèm tag, mặc định `ghcr.io/notivn/ads-mcp-simple` (chỉ đổi khi dùng bản fork; updater + compose cùng đọc) |
| `UPDATE_REPO` / `UPDATE_GITHUB_TOKEN` | - | repo GitHub để `worker` kiểm tra bản mới (mặc định `notivn/Ads-MCP-simple`) / token GitHub (PAT classic `repo` + `read:packages` của tài khoản chỉ có Read, dùng chung với `docker login`; bản cài cũ: Token B chỉ `repo`) nếu repo riêng tư; chỉ web + worker nhận |
| `UPDATER_VERIFY_SIGNATURE` | - | `0` = updater bỏ qua xác minh chữ ký cosign (không khuyến nghị). Updater tự đọc từ `.env` |
| `WEB_MEM_LIMIT` / `WORKER_MEM_LIMIT` / `MIGRATE_MEM_LIMIT` / `UPDATER_MEM_LIMIT` / `CADDY_MEM_LIMIT` / `CLOUDFLARED_MEM_LIMIT` | - | trần RAM (mặc định `1g` / `768m` / `768m` / `512m` / `256m` / `256m`); `WEB_PIDS_LIMIT` / `WORKER_PIDS_LIMIT` (`512` / `256`). Chỉ compose đọc |
| `SYSTEM_NOTICES_URL` | - | webhook thông báo hệ thống (`worker` GET 1 giờ/lần). Không đặt = webhook noti.vn; rỗng/`off` = tắt; chỉ nhận `https://` (13-system-notices.md) |
| `UPDATER_DOCKER_CONFIG` | - | thư mục `docker login` mount cho updater (mặc định `/root/.docker`) |
| `CADDY_REPLICAS` / `CADDY_CLIENT_IP` / `CADDY_TLS` / `WEB_HOST_PORT` | - | chọn phương án (§0); gen-env `--ssl` điền |
| `CADDY_SITE_SCHEME` | - | trống (mặc định) hoặc `http://` (phương án D) |
| `CADDY_HTTP_PORT_BIND` / `CADDY_HTTPS_PORT_BIND` | - | `[IP:]cổng` Caddy publish; mặc định `80` / `443`; D: `127.0.0.1:` |
| `CLOUDFLARED_REPLICAS` / `TUNNEL_TOKEN` / `CLOUDFLARED_PROTOCOL` | D | `1` = chạy cloudflared (mặc định `0`) / token tunnel (secret, dán từ dashboard, không sinh) / `auto` (mặc định) hoặc `http2` |
Config deploy đọc ở **runtime** (`src/server/env.ts`, validate bằng zod, thiếu biến → dừng với thông báo rõ). Không dùng `NEXT_PUBLIC_*` cho domain/secret.

## 2. Dockerfile (1 image, nhiều entrypoint)
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-slim@sha256:<digest> AS base          # ghim digest, viết thẳng (Dependabot cập nhật)
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build \
 && pnpm exec esbuild scripts/migrate.ts scripts/worker.ts scripts/cli.ts --bundle --platform=node --target=node24 \
      --format=esm --outdir=dist --out-extension:.js=.mjs --external:pg-native \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

FROM node:24-slim@sha256:<digest> AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 KEEP_ALIVE_TIMEOUT=130000
COPY --from=builder --chown=root:root /app/public ./public          # file app thuộc root: tiến trình node không sửa được
COPY --from=builder --chown=root:root /app/.next/standalone ./
COPY --from=builder --chown=root:root /app/.next/static ./.next/static
COPY --from=builder --chown=root:root /app/dist ./dist
COPY --from=builder --chown=root:root /app/drizzle ./drizzle
RUN mkdir -p /app/.next/cache && chown node:node /app/.next/cache \
 && rm -rf /usr/local/lib/node_modules/{npm,corepack} /usr/local/bin/{npm,npx,corepack,yarn,yarnpkg} /opt/yarn-v*
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```
- `next.config.ts`: `output: "standalone"`, `poweredByHeader: false`, `images.unoptimized: true` (không có ảnh remote).
- Builder kiểm tra `.next/standalone` không có `.env*` (Next chép `.env` vào standalone nếu có; `.dockerignore` đã chặn, đây là chốt thứ 2). Target `updater`: `node:24-alpine@sha256:…` + `apk add docker-cli docker-cli-compose cosign`.
- `next/font/google` tải font lúc build — build không có internet thì đổi sang `@fontsource-variable/inter`.

## 3. docker-compose.yml
Bản rút gọn để hiểu cấu trúc (file thật: không có `build:` - xem §0; có thêm `updater`, `deploy.replicas` của caddy, `ports` loopback của web, mount `./deploy/caddy`, ports của caddy qua biến `CADDY_*_PORT_BIND`, service `cloudflared` mặc định `replicas: 0` cho phương án D).
```yaml
name: ads-mcp
x-app: &app
  image: ${APP_IMAGE:-ghcr.io/notivn/ads-mcp-simple}:${APP_VERSION:?…}   # bắt buộc, không còn latest
  # không env_file: mỗi service có `environment:` theo danh sách (x-env-runtime / x-env-web, §0b)
  read_only: true
  cap_drop: [ALL]
  security_opt: ["no-new-privileges:true"]
  tmpfs: ["/tmp:size=64m"]
  restart: unless-stopped
services:
  db:
    image: postgres:18.6-trixie
    restart: unless-stopped
    environment: { POSTGRES_USER: adsmcp, POSTGRES_DB: adsmcp, POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?required}" }
    command: ["postgres", "-c", "default_toast_compression=lz4", "-c", "shared_buffers=256MB",
              "-c", "max_wal_size=2GB", "-c", "log_min_duration_statement=500ms",
              "-c", "log_parameter_max_length=0", "-c", "log_parameter_max_length_on_error=0"]   # không ghi bind param (bí mật) vào log
    volumes: ["pgdata:/var/lib/postgresql"]      # PG18+: KHÔNG phải /var/lib/postgresql/data
    shm_size: 256mb
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U adsmcp -d adsmcp"], interval: 5s, timeout: 3s, retries: 20, start_period: 10s }
  migrate:
    <<: *app
    command: ["node", "dist/migrate.mjs"]
    restart: "no"
    depends_on: { db: { condition: service_healthy } }
  web:
    <<: *app
    depends_on: { migrate: { condition: service_completed_successfully } }
    expose: ["3000"]
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: 15s, timeout: 5s, retries: 5, start_period: 20s }
  worker:
    <<: *app
    command: ["node", "dist/worker.mjs"]
    depends_on: { migrate: { condition: service_completed_successfully } }
  caddy:
    image: caddy:2.11-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    environment: { APP_DOMAIN: "${APP_DOMAIN}", ACME_EMAIL: "${ACME_EMAIL}" }
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data", "caddy_config:/config"]
    depends_on: { web: { condition: service_healthy } }
  backup:
    image: postgres:18.6-alpine
    restart: unless-stopped
    environment: { PGHOST: db, PGUSER: adsmcp, PGDATABASE: adsmcp, PGPASSWORD: "${POSTGRES_PASSWORD}", KEEP_DAYS: "14" }
    volumes: ["./backups:/backups"]
    depends_on: { db: { condition: service_healthy } }
    entrypoint: ["/bin/sh", "-c"]
    command: ["while true; do f=/backups/adsmcp_$$(date +%F_%H%M).dump; pg_dump -Fc -Z zstd:6 -f $$f && find /backups -name '*.dump' -mtime +$$KEEP_DAYS -delete; sleep 86400; done"]
volumes: { pgdata: {}, caddy_data: {}, caddy_config: {} }
```
- Postgres không publish port. Muốn backup không kèm log: thêm `--exclude-table-data='mcp_call_logs_p*'`.
- Service `updater` (profile `updater`, §6) là service duy nhất có `docker.sock`; dùng image riêng (`...-updater`, target `updater` của Dockerfile) vì cần docker CLI và chạy root, khác nguyên tắc "1 image web chạy user node".
- Tách tải MCP (tuỳ chọn, profile `scale`): thêm service `mcp` `<<: *app` giống `web`, sửa Caddy `handle @mcp { reverse_proxy mcp:3000 ... }`.
- Dev trên máy (Windows): `docker compose up -d db` (thêm `ports: ["127.0.0.1:5432:5432"]` trong `docker-compose.override.yml` - chỉ loopback, không bao giờ mở Postgres ra mạng) rồi `pnpm dev`; worker dev: `pnpm worker:dev`.

## 4. Caddyfile
```caddyfile
{
	email {$ACME_EMAIL}
	servers {
		timeouts {
			read_header 15s
			idle 5m
		}
	}
}

{$APP_DOMAIN} {
	log {
		output stdout
		format filter {
			request>uri regexp "^(/mcp/)[^/?#]+|([?&]auth_code=)[^&#]*" "${1}${2}[redacted]"
			request>headers>Authorization delete
			request>headers>Cookie delete
		}
	}
	header {
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
	@mcp path /mcp/*
	handle @mcp {
		header Referrer-Policy "no-referrer"
		request_body {
			max_size 1MB
		}
		reverse_proxy web:3000 {
			flush_interval -1
		}
	}
	handle {
		encode zstd gzip
		reverse_proxy web:3000
	}
}
```
- Ngoài `/mcp/*`, `handle` còn lại có `request_body { max_size 5MB }` (như `client_max_body_size 5m` của Nginx). Chưa đặt `servers.timeouts.read_body`: cần kiểm thử với lệnh MCP > 30 s + SSE trước khi thêm.
- Không `encode` trên `/mcp` (tránh buffer SSE). Caddy không có timeout upstream mặc định → tool chạy lâu không bị cắt (Claude giới hạn 240 s/lệnh; app tự timeout gọi nền tảng 60 s).
- File thật có thêm `import /etc/caddy/deploy/client-ip-{$CADDY_CLIENT_IP:direct}.caddy` (trong `servers`), `import /etc/caddy/deploy/tls-{$CADDY_TLS:auto}.caddy` (đầu site block) và `header_up X-Forwarded-For {client_ip}` (§0).
- Đặt Cloudflare (proxy) phía trước: Proxy Read Timeout **125 s** giữa hai lần đọc (lỗi 524, chỉ Enterprise tăng được), bắt buộc SSL "Full (strict)" + Origin CA, tắt Bot Fight Mode (gói Free không skip được theo path). Chi tiết: `docs/deploy-vps.md` §9.
- Site address thật là `{$CADDY_SITE_SCHEME}{$APP_DOMAIN}` (biến môi trường Caddy được thay trước khi parse, ghép được thành 1 token). Phương án D (Cloudflare Tunnel): `CADDY_SITE_SCHEME=http://`, `CADDY_TLS=tunnel`, `CADDY_CLIENT_IP=tunnel` → server chỉ nghe `:80`, không có app `tls`/ACME (log cảnh báo "server is listening only on the HTTP port, so no automatic HTTPS will be applied" là bình thường). cloudflared buffer phản hồi trừ khi có `Content-Type: text/event-stream` (hoặc không có Content-Length/chunked), nên SSE của MCP vẫn được đẩy ngay. Giới hạn 125 s của Cloudflare được coi là áp dụng cả với hostname đi qua tunnel (tài liệu không nói rõ). Chi tiết: `docs/deploy-vps.md` §10b.

### 4b. Link tạm cho video Google Drive `/dl/<token>/<tên file>` (2026-10-09)
Meta (`file_url`) và TikTok (`UPLOAD_BY_URL`) tự tải video từ tên miền của mình; app stream từ Google Drive qua route `src/app/dl/[token]/[name]/route.ts` (logic: `src/server/drive/relay-serve.ts`, thiết kế: `15-google-drive-media.md` §8). Token `adr_…` 256-bit nằm **trong path** (bí mật như key MCP), TTL 60 phút, tối đa 30 lượt GET (chỉ tính GET không có Range hoặc Range bắt đầu từ byte 0; các Range khác không tính lượt nhưng mỗi link chỉ phát tối đa 3 × dung lượng file), 8 stream/token + 16 stream/IP (IPv6 gom /64) + 32 stream/tiến trình → 429 `Retry-After: 5`; mỗi stream bị cắt sau 30 phút. Token sai/không tồn tại (GET + HEAD) bị đếm theo IP: quá 20 lần/10 phút → 429 cho token lạ (token của link còn sống vẫn qua, không tốn truy vấn DB cho token lạ). Mỗi GET kiểm tra lại quyền MCP: tài khoản QC + quyền tạo, thư mục Drive còn được cấp (`source_id`), hoặc công tắc link công khai còn bật. HEAD không tính lượt, trả kích thước/loại từ DB. Mọi lỗi → 404 text (không chuyển hướng). Tải từ Drive luôn xin `Accept-Encoding: identity`; token Google chỉ gửi tới host ghim (`www/sheets.googleapis.com`, `lh3–lh6.googleusercontent.com`, `drive-thirdparty.googleusercontent.com`).
- **App**: `src/proxy.ts` loại `dl/` khỏi matcher (không bị đẩy về /login). `next.config.ts` có mục `/dl/:path*` đặt CSP `default-src 'none'; sandbox`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` (route handler không ghi đè được header đã đặt trong next.config); route đặt thêm `Content-Type` (đã kiểm tra), `Content-Length`, `Content-Range` (206), `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Robots-Tag: noindex`. Không có `Content-MD5`. Log request lúc dev bỏ qua `/dl/`.
- **Caddy**: khối `@relay path /dl/*` - không `encode` (Range phải đúng byte), `reverse_proxy web:3000 { flush_interval -1 }`, body tối đa 1 KB (chỉ GET/HEAD), `Referrer-Policy: no-referrer` + `Cache-Control: no-store`; regexp che log (`request>uri`, Referer, `error`, `msg` - global và access log) thêm `/dl/` cạnh `/mcp/`. Không timeout upstream (video lớn tải lâu).
- **Nginx mẫu** (`deploy/nginx/ads-mcp.conf`): `location /dl/` với `proxy_buffering off`, `proxy_cache off`, `gzip off`, `client_max_body_size 1k`, `error_log … crit`; map `$adsmcp_log_uri` / `$adsmcp_log_referer` che cả `/dl/<token>`.
- **Cloudflare (B, D)**: **không** bật Bot Fight Mode / challenge / Under Attack / Browser Integrity Check cho `/dl/*` (máy chủ Meta/TikTok không vượt được challenge JavaScript → tải video lỗi); gói Pro+ thêm `/dl/` vào rule WAF **Skip** như `/mcp/`. Không tạo rule "Cache Everything" cho `/dl/*` (app trả `no-store`; Cloudflare tôn trọng). Giới hạn 100 MB của Cloudflare chỉ áp cho **body request**, không cho phản hồi → video lớn tải được qua proxy/tunnel (**UNVERIFIED** với video 200–500 MB - thử thật trước khi phát hành).
- **Cloudflare Access (D, tuỳ chọn)**: nếu bật Access cho giao diện web, thêm ứng dụng **Bypass / Everyone** cho path `dl/*` như `mcp/*` (máy chủ Meta/TikTok không đăng nhập Access được).
- **Băng thông**: mỗi lượt tải video đi Drive → VPS → nền tảng (vào + ra); không ghi đĩa, không đệm toàn bộ (RAM chỉ vài chunk/stream).
- Job `drive.cleanup` (03:50 hằng ngày) xoá link hết hạn > 24 h, đánh dấu lỗi các lượt tải video nền bị treo, xoá lượt tải đã xong > 30 ngày; `drive.health` (phút 40 mỗi 6 giờ) kiểm tra lại thông tin xác thực + nguồn Drive.
- **Tải video lớn ở nền** (Meta > 50 MB, TikTok > 10 MB): tool MCP tạo bản ghi `media_upload_jobs` và gửi job `media.video_upload` (pg-boss, không thử lại, hết hạn 2 giờ) cho worker; worker đọc Drive bằng Range (≤ 32 MB/lần; mỗi lúc chỉ giữ 1 đoạn trong RAM — TikTok 20 MB, Meta theo offset Meta trả, tối đa 64 MB; 1 job một lúc → đủ với `WORKER_MEM_LIMIT` 768m) và tải lên nền tảng theo phiên chia đoạn. Worker ghi nhịp sống (`updated_at`) 60 s/lần; job `media.upload_sweep` (10 phút/lần) đánh dấu lỗi lượt tải không có nhịp sống 30 phút (worker chết) — lượt đã bị đánh lỗi thì worker không ghi đè thành `done`. Giới hạn: 3 lượt đang chạy / MCP, 5 / chủ MCP, 30 lượt chờ toàn hệ thống. Mỗi lượt kết thúc ghi 1 dòng `mcp_call_logs` (tool `media.video_upload`); worker flush log khi dừng. Worker phải chạy thì video lớn mới tải được; web chỉ gửi job (pg-boss send-only).

## 5. Vận hành
- **Cập nhật**: admin bấm Cập nhật trong web (service `updater`, §6) hoặc tay (§6.8, `docs/deploy-vps.md` §11). Updater chỉ đổi image; bản phát hành đổi `docker-compose.yml`/`Caddyfile`/`deploy/` thì ghi chú phát hành phải yêu cầu `git pull` + `docker compose up -d --no-build` (+ `restart caddy`). Build từ mã nguồn (máy dev): `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build` (migrate chạy tự động trước web/worker; có advisory lock).
- **Tạo admin bằng CLI** (thay cho /setup, hoặc khi quên mật khẩu): `docker compose run --rm web node dist/cli.mjs create-admin --email a@b.com` (mật khẩu tạm tự sinh, hoặc `-e ADMIN_PASSWORD` không kèm giá trị - lấy từ shell; `ADMIN_PASSWORD` trong `.env` không tới container vì env allowlist - / `--password-stdin` — không dùng `--password` trên dòng lệnh) · `reset-password <email>` · `reset-2fa <email>` · `unlock <email>` (gỡ khoá đăng nhập + khoá 2FA).
- **Google refresh token helper** (chỉ khi kết nối Google Ads dùng OAuth; service account không cần; loopback redirect, chỉ qua SSH tunnel): trên máy bạn `ssh -L 8085:127.0.0.1:8085 user@vps`, rồi trên VPS `docker compose run --rm -p 127.0.0.1:8085:8085 web node dist/cli.mjs google:refresh-token --client-id ... --host 0.0.0.0` (client secret nhập ẩn, hoặc `-e GOOGLE_ADS_CLIENT_SECRET` lấy từ shell). Không bao giờ publish `-p 8085:8085` ra mọi interface; ngoài Docker helper mặc định chỉ nghe `127.0.0.1`. Consent screen phải In production + Verify Branding (Testing → refresh token hết hạn sau 7 ngày); không cần developer token.
- **Telegram**: máy chủ cần ra Internet tới `api.telegram.org:443` (hoặc `TELEGRAM_API_BASE_URL`). Không cần mở cổng vào (không dùng webhook Telegram).
- **Xoay khoá mã hoá**: thêm `2:<key mới>` lên đầu `ENCRYPTION_KEYS` → restart → `node dist/cli.mjs reencrypt` (hoặc job tự chạy) → bỏ key cũ.
- **Backup/restore**: file `./backups/*.dump` → đẩy off-site (restic/rclone, mã hoá) + sao lưu `.env` riêng chỗ khác; restore: `pg_restore -c -d adsmcp <file>`; test restore định kỳ.
- **Theo dõi**: `docker compose logs -f web worker`; trang Cài đặt → Thông tin hệ thống (dung lượng log, partition, phiên bản API sắp hết hạn).
- Tài nguyên tham khảo: web ~250 MB RAM, worker ~120 MB, Postgres theo dung lượng log (ước ~1–2 KB/dòng log MCP).

## 6. Cập nhật tự động
Service tên `updater`, profile compose `updater` (bật bằng `COMPOSE_PROFILES=updater` trong `.env`). Thiết kế & hợp đồng dữ liệu: `10-update-system.md`; mục này là phần hạ tầng/vận hành. Admin bấm **Cập nhật** trong web; web chỉ ghi 1 dòng vào bảng `system_update_requests`, service `updater` (poll DB) làm phần còn lại. **Web/worker không bao giờ có `docker.sock`.** Khi updater tắt/lỗi, cập nhật tay nhanh nhất: sửa `APP_VERSION=X.Y.Z` trong `.env` rồi `docker compose pull && docker compose up -d` (đầy đủ có sao lưu và migrate: §6.8).

### 6.1 Bật / tắt
- **Mặc định BẬT** cho cài mới: `gen-env.mjs`/`gen-secrets.sh` ghi `COMPOSE_PROFILES=updater` và `HOST_PROJECT_DIR=<thư mục hiện tại>` vào `.env` (lý do: chủ dự án muốn admin tự bấm cập nhật; thiếu updater thì web chỉ hiện lệnh chạy tay). Cài cũ (đã có `.env`): thêm 2 dòng đó rồi `docker compose up -d`.
- **Tắt**: dùng `--no-updater` khi sinh `.env`, hoặc xoá/để trống `COMPOSE_PROFILES` rồi `docker compose rm -sf updater`. Khi tắt, web vẫn báo có bản mới nhưng nút Cập nhật bị khoá (không có heartbeat) và hiện hướng dẫn §6.8.
- Chỉ dùng được khi chạy **image dựng sẵn từ registry** (GHCR). Nếu bạn tự build (`docker-compose.build.yml`, không có image tag phát hành), hãy tắt updater và cập nhật tay bằng `git pull`.

### 6.2 Quy trình 1 lần cập nhật
`updater` (poll 5 s, heartbeat `app_settings.updater_heartbeat` mỗi 30 s, 1 yêu cầu một lúc, `FOR UPDATE SKIP LOCKED`) chạy tuần tự, mỗi bước có timeout và ghi `step`/`message`/`log` (đuôi ≤ 64 KB, đã redact) lên dòng yêu cầu:

| Bước (`step`) | Việc làm | Lỗi thì |
|---|---|---|
| (nhận việc) | Chỉ nhận dòng `pending` **trẻ hơn 10 phút**; dòng `pending` cũ hơn bị đánh `failed` (updater bật lại sau nhiều ngày không được chạy yêu cầu cũ) | `failed` + activity log |
| (kiểm tra) | `target_version` đúng `x.y.z`, **lớn hơn** bản đang chạy (`from_version` và `APP_VERSION` trong `.env`); image cố định `APP_IMAGE` (mặc định `ghcr.io/notivn/ads-mcp-simple`) | `failed`, không chạy lệnh nào |
| `backup` | `docker compose exec -T db pg_dump -Fc -Z zstd:6` → `./backups/pre-update-<UTC>.dump` (quyền 0600, **giữ lại**, không tự xoá), rồi `pg_restore --list` kiểm tra đọc lại được | `failed` |
| `pull` | `docker pull <image>:<ver>`; kiểm tra image mang đúng `APP_BUILD_VERSION=<ver>`; `cosign verify` digest trong `RepoDigests` với danh tính đúng tag `v<ver>` (§0b; bỏ qua khi image fork hoặc `UPDATER_VERIFY_SIGNATURE=0`, có ghi log) | `failed` |
| `migrate` | `docker compose run --rm migrate` bằng **image mới** (chọn bằng biến môi trường `APP_VERSION` chỉ cho lệnh này); web/worker cũ vẫn đang chạy | `failed`, **không đụng bản đang chạy**, `.env` chưa sửa |
| `restart` | Ghi nguyên tử `APP_VERSION=<ver>` vào `.env` (file tạm cùng thư mục + rename, giữ quyền/chủ sở hữu, bản gốc ở `.env.bak`, chỉ đổi đúng dòng đó) rồi `docker compose up -d --no-deps web worker` | rollback |
| `healthcheck` | `docker compose ps --format json`: web `healthy`, worker `running`, đúng tag, ổn định ≥ 10 s; tối đa 5 phút; container khởi động lại liên tục (3 lần quan sát) hoặc `exited`/`unhealthy` → lỗi ngay | rollback |
| `rollback` | Khôi phục `APP_VERSION` cũ (hoặc xoá dòng nếu trước đó chưa có) → `up -d --no-deps web worker` → healthcheck bản cũ | `rolled_back`; nếu rollback cũng lỗi → `failed` kèm lời nhắc xử lý thủ công + tên file backup |

Kết thúc ghi `activity_logs` (`system.update_succeeded|failed|rolled_back`, actor = người bấm; metadata: `from`, `to`, `durationMs`, `failedStep`, `backupFile`, `rollback`) **trong cùng transaction** với việc đổi `status`. Dòng `running` quá 30 phút, hoặc còn sót khi updater khởi động lại, bị đánh `failed`.
**Rollback không đảo migration**, vì vậy migration phải tương thích ngược (§6.7). Rollback không đụng DB: nếu một migration đã chạy xong rồi bản mới mới lỗi, dữ liệu vẫn ở schema mới, bản cũ chạy tiếp trên schema đó.
**Cuối quy trình thành công**, updater tự thay chính nó: `docker compose pull updater`, xác minh chữ ký image updater mới (lỗi = giữ updater cũ), rồi chạy 1 container tạm (cùng image updater **mới**, `--rm`, tên `ads-mcp-updater-selfupdate`) thực hiện `docker compose up -d --no-deps --force-recreate updater`. Phải dùng container tạm vì tiến trình `docker compose` chạy trong container updater cũ sẽ bị kill giữa chừng khi container đó dừng. Chỉ làm sau khi trạng thái cuối đã được ghi; lỗi ở bước này không ảnh hưởng kết quả cập nhật (updater cũ vẫn chạy, `docker compose up -d` sẽ thay nó).

### 6.3 Đường dẫn thư mục dự án & đăng nhập registry
- `docker compose` chạy **trong container** gửi đường dẫn bind mount (`./Caddyfile`, `./backups`) cho Docker daemon của **máy chủ**, nên container updater phải thấy thư mục dự án ở **đúng cùng đường dẫn tuyệt đối** như trên máy chủ. Compose mount `${HOST_PROJECT_DIR}:${HOST_PROJECT_DIR}` (mặc định lấy `$PWD` của shell chạy `docker compose` nếu `HOST_PROJECT_DIR` trống). Đường dẫn chỉ gồm `A-Za-z0-9._/-` (không khoảng trắng). Mount cả **thư mục** (không mount riêng `.env`) vì ghi nguyên tử cần rename trong thư mục.
- Image riêng tư (repo/package GHCR private): trên VPS chạy `docker login ghcr.io -u <user> --password-stdin` với **token GitHub - PAT classic `repo` + `read:packages`** (bản cài cũ: Token A chỉ `read:packages`; GHCR không nhận PAT fine-grained; cosign của updater dùng cùng thông tin đăng nhập này) bằng user sẽ chạy compose; updater mount thư mục cấu hình đó chỉ-đọc (`UPDATER_DOCKER_CONFIG`, mặc định `/root/.docker`; nếu đăng nhập bằng user khác root, đặt `UPDATER_DOCKER_CONFIG=/home/<user>/.docker` trong `.env`). Credential chỉ nằm trên máy chủ, không vào DB/log. Docker credential helper kiểu `desktop`/`secretservice` không dùng được trong container: dùng đăng nhập thường (file `config.json`).
- Kiểm tra bản mới trên repo GitHub riêng tư: `UPDATE_GITHUB_TOKEN` = **cùng token GitHub** (PAT classic `repo` + `read:packages`; bản cài cũ: Token B chỉ `repo`) của tài khoản outside collaborator quyền Read (PAT fine-grained không truy cập được repo của tổ chức khi tài khoản chỉ là outside collaborator) trong `.env` cho `web` + `worker`; updater không nhận biến này (updater dùng thông tin `docker login`).

### 6.4 Rủi ro `docker.sock` và biện pháp giảm thiểu
Mount `docker.sock` cho một container **tương đương quyền root trên máy chủ** (tạo container đặc quyền, mount `/`…). Đó là cái giá của việc cập nhật bằng 1 cú bấm. Giảm thiểu đã áp dụng:
- **Chỉ `updater` có `docker.sock`**; web/worker (bề mặt tấn công chính, nhận request từ Internet và từ AI) thì không. Chiếm được web **không** kéo theo chiếm được máy chủ.
- `updater` **không publish port, không nhận kết nối vào, không có HTTP server**. Đầu vào duy nhất là bảng `system_update_requests`, và chỉ web (server action admin + re-auth) ghi vào đó. Kể cả kẻ ghi được vào DB cũng chỉ chọn được **một phiên bản `x.y.z` mới hơn** của image cố định; không thể chèn lệnh, image, đường dẫn hay tham số.
- Mọi lệnh gọi bằng `spawn(args[])` (không shell), giá trị chèn vào lệnh đều đã qua regex/so sánh semver; `target_version` > bản đang chạy (chống hạ cấp có chủ đích).
- Image đích (và image updater mới) phải có chữ ký cosign của workflow `docker.yml` cho đúng tag (§0b): kẻ chiếm được GHCR/tag mà không có OIDC của workflow trên repo không đưa được image vào máy khách.
- Container: `read_only: true` + `tmpfs /tmp`, `mem_limit` 512m, `pids_limit` 256, `cap_drop: ALL` (chỉ thêm `CHOWN`, `DAC_OVERRIDE`, `FOWNER` để ghi `.env` giữ nguyên chủ sở hữu/quyền), `no-new-privileges`, không biến môi trường bí mật ngoài `DATABASE_URL` (tiến trình con chỉ nhận danh sách biến cho phép), log cấp redact (không bao giờ ghi nội dung `.env`, token, mật khẩu).
- Chạy root trong container là bắt buộc để dùng `docker.sock` và ghi `.env`; không có cách rootless đơn giản với mô hình "docker compose bên trong container".
- Updater dùng chính user DB `adsmcp` (cùng `DATABASE_URL` với app). Thư mục dự án được mount ghi được: coi updater như thành phần tin cậy ngang với `docker compose` trên máy chủ.
- Muốn **không có** thành phần này: tắt updater (§6.1) và cập nhật tay (§6.8). Nên bật firewall, chỉ SSH bằng khoá, và chỉ cấp quyền admin web cho người cần thiết (re-auth bắt buộc trước khi cập nhật).

### 6.5 Phát hành (checklist cho người duy trì)
1. `pnpm lint && pnpm typecheck && pnpm test` xanh; migration mới tuân §6.7.
2. Sửa `package.json#version` thành `X.Y.Z` (semver, không có `v`), commit `chore(release): vX.Y.Z`.
2b. **Build local trước, push sau**: `docker build --build-arg APP_BUILD_VERSION=X.Y.Z -t ghcr.io/notivn/ads-mcp-simple:X.Y.Z .` và `docker build --target updater --build-arg APP_BUILD_VERSION=X.Y.Z -t ghcr.io/notivn/ads-mcp-simple-updater:X.Y.Z .` (**chỉ để chạy thử**: image build tay không có chữ ký, **không bao giờ** `docker push` image/tag phát hành bằng tay - updater của khách sẽ từ chối), rồi smoke test stack production local (`APP_VERSION=X.Y.Z docker compose up -d --no-build`: migrate exit 0, web healthy). Ghi chú phát hành nêu rõ nếu đổi `docker-compose.yml`/`Caddyfile`/`deploy/`/`.env.example` (updater không cập nhật các file này). Checklist đầy đủ: `docs/deploy-vps.md` §15.2.
2c. **Tag thử `vX.Y.Z-rc.1` trước bản thật**: `package.json#version` = `X.Y.Z-rc.1` → commit `main` → push tag rc → CI build + ký (job `release` bỏ qua vì không phải `vX.Y.Z`; không gắn `latest`/`X.Y`; update-check chỉ nhận Release không phải prerelease và tag dạng `vX.Y.Z`; updater từ chối đích không phải `x.y.z` → khách không thấy bản rc). Lấy digest index bằng `docker buildx imagetools inspect <image>:X.Y.Z-rc.1 --format '{{.Manifest.Digest}}'` rồi xác minh cả 2 image bằng cosign **của image updater rc**: `docker run --rm -v "$HOME/.docker:/root/.docker:ro" -e TUF_ROOT=/tmp/sigstore-tuf --entrypoint cosign ghcr.io/notivn/ads-mcp-simple-updater:X.Y.Z-rc.1 verify --certificate-identity https://github.com/notivn/Ads-MCP-simple/.github/workflows/docker.yml@refs/tags/vX.Y.Z-rc.1 --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/notivn/ads-mcp-simple@<digest>` (và `...-updater@<digest>`). Docker Desktop dùng `credsStore`: đăng nhập vào thư mục `--config` riêng rồi mount thư mục đó. Đạt mới đổi version về `X.Y.Z` và làm bước 3; không đạt thì không phát hành. Chi tiết: `docs/deploy-vps.md` §15.2 bước 5b.
3. `git push origin main`, rồi `git tag vX.Y.Z && git push origin vX.Y.Z` (tag phải trỏ vào commit trên `main`). **Bản phát hành chỉ do CI tạo** (đã ký).
4. GitHub Actions `docker.yml` (`permissions: {}` ở gốc, quyền cấp từng job; action ghim SHA): kiểm tra `package.json#version` khớp tag, tag nằm trên nhánh mặc định, bản stable chưa có Release (không ghi đè image đã phát hành; gói Free không có tag ruleset nên đây là chốt chặn) → build/push `ghcr.io/notivn/ads-mcp-simple:X.Y.Z` và `...-updater:X.Y.Z` (build-arg `APP_BUILD_VERSION=X.Y.Z`, `provenance` + `sbom`) → `cosign sign` keyless cả 2 digest (`id-token: write`) → job `release` tạo GitHub Release (cần `contents: write` chỉ cho job này) **sau khi** cả hai image đã đẩy và ký xong. Chạy lại job sau lỗi giữa chừng vẫn được (Release tạo cuối cùng).
5. Tag có hậu tố (`vX.Y.Z-rc.1`, khi đó `package.json#version` cũng là `X.Y.Z-rc.1`) chỉ build image, **không** tạo Release nên admin không thấy là bản mới. Không còn tag `latest` (`flavor: latest=false`). Chạy tay (`workflow_dispatch`) chỉ trên nhánh mặc định: đẩy `:main`/`:sha-xxxx` với `APP_BUILD_VERSION=dev`.
6. Xác minh chữ ký cả 2 image (lệnh ở §6.8), kiểm tra trang Release; trên một môi trường thử, admin bấm Cập nhật thử trước khi thông báo cho khách.
Sửa lỗi sau phát hành: tạo bản vá mới `X.Y.(Z+1)` (updater chỉ đi lên, không cập nhật xuống thấp hơn).

### 6.6 Khôi phục từ file `pre-update-*.dump`
Dùng khi `failed` ở bước rollback, hoặc muốn quay hẳn về dữ liệu trước cập nhật (mất dữ liệu phát sinh sau thời điểm backup):
```bash
cd <thư mục dự án>
ls -lh backups/pre-update-*.dump
# 1) trả APP_VERSION về bản cũ (.env.bak là bản .env trước lần cập nhật gần nhất)
sed -i 's/^APP_VERSION=.*/APP_VERSION=<bản cũ>/' .env      # hoặc: cp .env.bak .env
# 2) dừng ứng dụng, khôi phục dữ liệu, chạy lại
docker compose stop web worker
docker compose exec -T db pg_restore --clean --if-exists -U adsmcp -d adsmcp < backups/pre-update-<thời gian>.dump
docker compose up -d
docker compose ps
```
Chỉ rollback code (không cần khôi phục DB) là đủ trong đa số trường hợp, nhờ migration tương thích ngược. File dump **không chứa `ENCRYPTION_KEYS`** (xem mục Backup/restore ở trên); updater không tự xoá file `pre-update-*`: dọn tay định kỳ (`ls -t backups/pre-update-* | tail -n +6 | xargs rm -f`).

### 6.7 Quy tắc migration tương thích ngược (expand/contract, 1 phiên bản)
Vì `migrate` chạy trước khi thay web/worker, và rollback không đảo migration, **schema sau migration phải chạy được với cả bản code mới và bản code ngay trước đó**:
- Thêm cột/bảng/index: được (cột mới nullable hoặc có default).
- **Không** xoá/đổi tên/đổi kiểu cột, bảng, enum trong cùng phiên bản dùng code mới. Làm 2 bước: bản N thêm cái mới + code ghi cả hai/đọc cái mới có fallback; bản N+1 (sau khi mọi nơi đã lên N) mới xoá cái cũ.
- Không thêm ràng buộc `NOT NULL` không default, không thêm CHECK/UNIQUE có thể làm bản cũ ghi lỗi.
- Migration dài/khoá bảng lớn (log theo partition): tách nhỏ, `CREATE INDEX CONCURRENTLY` ở migration riêng; hạn chế khoá vì bản cũ vẫn đang phục vụ trong lúc migrate.
### 6.8 Cập nhật tay (khi tắt updater hoặc updater lỗi)
```bash
cd <thư mục dự án>
docker login ghcr.io                       # nếu image riêng tư
docker compose exec -T db pg_dump -U adsmcp -d adsmcp -Fc -Z zstd:6 > backups/pre-update-manual.dump
APP_VERSION=X.Y.Z docker compose pull web worker migrate
APP_VERSION=X.Y.Z docker compose run --rm migrate
sed -i 's/^APP_VERSION=.*/APP_VERSION=X.Y.Z/' .env || echo 'APP_VERSION=X.Y.Z' >> .env
docker compose up -d --no-deps web worker
docker compose ps                          # web phải healthy
```
Tự xác minh chữ ký image (cosign ≥ 3, đã `docker login ghcr.io`; làm cả với `...-updater`):
```bash
cosign verify ghcr.io/notivn/ads-mcp-simple:X.Y.Z \
  --certificate-identity https://github.com/notivn/Ads-MCP-simple/.github/workflows/docker.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### 6.9 Kiểm chứng đã làm / chưa làm
Đã chạy thật trên Docker (máy dev, registry cục bộ `localhost:5000`, stack giả `db`/`migrate`/`web`/`worker`/`updater` + Postgres thật): thành công 1.1.0 → 1.2.0 (có backup, pull, migrate, ghi `.env`, healthcheck, activity log, tự thay updater), migrate lỗi (không đụng bản chạy, log đã redact), bản mới crash-loop → rollback, `.env` giữ quyền/chủ sở hữu khi chạy với `cap_drop: ALL`. Bản 2026-10-05 (máy dev): `docker compose config` với `.env` giả (có/không `APP_VERSION`, kèm overlay build và compose dev); image tạm từ `node:24-alpine@sha256` cài `cosign` 3.0.6 và chạy được với `read_only` + `cap_drop: ALL` + `no-new-privileges`, npm/yarn/corepack đã gỡ; `caddy validate` với Caddyfile mới dưới `read_only` + `cap_drop: ALL` + `NET_BIND_SERVICE`; test đơn vị updater (cosign giả lập). **Chưa** kiểm chứng: ký + xác minh cosign thật trên GHCR riêng tư (chạy 1 lần trên tag thử trước khi phát hành), stack production đầy đủ với compose mới (read-only web/worker, mạng `edge`, backup với `DAC_OVERRIDE`). **Chưa** kiểm chứng (từ trước): GHCR thật (đăng nhập/pull image riêng tư), workflow GitHub Actions chạy thật (chỉ kiểm cú pháp + script tính version), VPS Linux thật, image web thật (migration thật của app mới), kết hợp với phần web/UI của hệ thống cập nhật.
