---
paths:
  - "Dockerfile"
  - "docker-compose*.yml"
  - "Caddyfile"
  - ".env.example"
  - "scripts/*.sh"
  - ".github/workflows/**"
---

# Quy tắc triển khai (đọc kèm `.claude/docs/07-deployment.md`)

- 1 image, nhiều entrypoint (`server.js` web, `dist/worker.mjs`, `dist/migrate.mjs`, `dist/cli.mjs`); chạy user `node`, file app thuộc root (chỉ `/app/.next/cache` ghi được); `output: "standalone"`. `FROM` ghim digest, viết thẳng (không qua ARG).
- Compose: `db` (postgres:18.x, volume mount `/var/lib/postgresql` — **không** `/data`), `migrate` (one-shot) → `web` + `worker` (depends_on `service_completed_successfully`), `caddy`, `backup`. Postgres không publish port ở production. Image bên thứ ba ghim digest.
- **Không `env_file`** cho service app: mỗi service có `environment:` theo danh sách (`x-env-runtime`, `x-env-web`), mục dạng `TÊN:` không giá trị (không bao giờ `${VAR:-}`). App đọc biến môi trường mới → thêm vào đúng danh sách. Worker không nhận secret của web.
- Hardening: `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, tmpfs, `mem_limit`/`pids_limit` qua biến `.env` có mặc định. Caddy/cloudflared chỉ ở mạng `edge` (không thấy db); giữ mạng `default` cho db/app (tương thích updater cũ).
- Mọi thay đổi compose phải chạy được với: image mới + `docker-compose.yml`/`.env` cũ, updater cũ + compose mới, và compose mới sau `git pull`. Không thêm biến `.env` **bắt buộc** mới (updater không sửa compose/.env ngoài `APP_VERSION`). `APP_VERSION` bắt buộc (không `latest`).
- CI: action ghim commit SHA (`# vX.Y.Z`), `permissions: {}` ở gốc + quyền từng job, `persist-credentials: false`; image phát hành chỉ do `docker.yml` đẩy và ký cosign.
- Caddy: log filter che `/mcp/<key>` + xoá header Authorization/Cookie; `/mcp/*` không `encode`, `flush_interval -1`, `request_body max_size 1MB`, `Referrer-Policy: no-referrer`; HSTS, nosniff, DENY frame.
- `.env.example` chỉ placeholder + chú thích tiếng Việt cách sinh (`openssl rand -base64 32`); nhắc sao lưu `ENCRYPTION_KEYS` riêng.
- Config deploy đọc runtime (không bake domain vào image). `KEEP_ALIVE_TIMEOUT=130000`.
- Không thêm service cần Redis/queue ngoài trừ khi chủ dự án đồng ý (pg-boss dùng Postgres).
- Domain cần A record IPv4 (Claude connector chỉ IPv4).
