---
name: verify
description: Kiểm chứng thay đổi trước khi báo xong — chạy lint, typecheck, unit test, build (và e2e/docker khi liên quan), rồi báo cáo trung thực. Dùng sau mỗi tính năng/sửa lỗi hoặc khi người dùng hỏi "đã chạy được chưa".
argument-hint: "[quick|full]"
allowed-tools: Bash(pnpm lint*) Bash(pnpm typecheck*) Bash(pnpm test*) Bash(pnpm build*) Bash(pnpm exec *) Bash(docker compose ps*) Bash(docker compose config*) Bash(docker compose logs *) Bash(git status*) Bash(git diff*)
---

# Verify

Chế độ: `$ARGUMENTS` (mặc định `quick`).

## quick
1. `git status` + `git diff --stat` để biết phạm vi thay đổi.
2. `pnpm lint` → `pnpm typecheck` → `pnpm test` (Vitest). Dừng ở lỗi đầu tiên, sửa, chạy lại.
3. Nếu thay đổi chạm UI (`src/app/**`, `src/components/**`, `globals.css`): chạy `pnpm dev` (nếu chưa chạy), mở trang bằng Chrome DevTools MCP, chụp **sáng + tối**, **390px + 1440px**, kiểm tra console không lỗi.
4. Nếu chạm `src/server/mcp/**`: gọi thử endpoint bằng MCP client (Inspector hoặc `claude mcp add --transport http test-local http://localhost:3000/mcp/<key-dev>`) — `tools/list` đúng theo quyền, 1 tool đọc chạy được, key sai trả 404.
5. Nếu chạm schema DB: `pnpm db:generate` không sinh diff ngoài ý muốn; đọc lại SQL.

## full (trước khi kết thúc một giai đoạn roadmap)
Tất cả bước quick, cộng:
- `pnpm build` (Next standalone) thành công.
- `pnpm test:e2e` (Playwright) xanh.
- `docker compose config` hợp lệ; nếu có thay đổi Dockerfile/compose: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build` (hỏi người dùng trước), kiểm tra `web` healthy, `migrate` exit 0, `worker` không lỗi trong log.
- Grep log app + Caddy để chắc chắn không có token/key thô (`EAA`, `sk-`, `amcp_`, `Bearer `).
- Cập nhật checklist trong `.claude/docs/08-roadmap.md`.

## Báo cáo (tiếng Việt)
- Đã chạy gì, kết quả từng bước (✔/✖ + trích lỗi ngắn).
- Cái gì **chưa** kiểm chứng được và vì sao (vd: chưa có token thật để test thao tác ghi).
- Không nói "đã xong" nếu còn bước đỏ.
