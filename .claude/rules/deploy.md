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

- 1 image, nhiều entrypoint (`server.js` web, `dist/worker.mjs`, `dist/migrate.mjs`, `dist/cli.mjs`); chạy user `node`; `output: "standalone"`.
- Compose: `db` (postgres:18.x, volume mount `/var/lib/postgresql` — **không** `/data`), `migrate` (one-shot) → `web` + `worker` (depends_on `service_completed_successfully`), `caddy`, `backup`. Postgres không publish port ở production.
- Caddy: log filter che `/mcp/<key>` + xoá header Authorization/Cookie; `/mcp/*` không `encode`, `flush_interval -1`, `request_body max_size 1MB`, `Referrer-Policy: no-referrer`; HSTS, nosniff, DENY frame.
- `.env.example` chỉ placeholder + chú thích tiếng Việt cách sinh (`openssl rand -base64 32`); nhắc sao lưu `ENCRYPTION_KEYS` riêng.
- Config deploy đọc runtime (không bake domain vào image). `KEEP_ALIVE_TIMEOUT=130000`.
- Không thêm service cần Redis/queue ngoài trừ khi chủ dự án đồng ý (pg-boss dùng Postgres).
- Domain cần A record IPv4 (Claude connector chỉ IPv4).
