# Kế hoạch thực thi & điều phối agent

> Orchestrator (phiên Claude chính) giữ: nền móng, schema DB + migration, dependency, merge, review cuối. Agent làm việc trong **git worktree riêng** (branch `feat/<tên>`), chỉ sửa file thuộc **vùng sở hữu** của mình, commit cục bộ trên branch, KHÔNG push, KHÔNG `pnpm add` (cần thư viện → ghi vào báo cáo), KHÔNG sửa schema/migration (cần → báo orchestrator).

## Đợt 0 — Nền móng (orchestrator)
- Scaffold Next 16.3.8 + shadcn `radix-maia` (Hugeicons) trong `src/`, Inter, git, LICENSE, `.env.example`, `docker-compose.dev.yml` (Postgres 18 cổng 5433), `scripts/gen-env.mjs`.
- Cài toàn bộ dependency + thêm toàn bộ component shadcn cần dùng.
- Code nền dùng chung (hợp đồng giữa các agent):
  - `src/server/env.ts`, `src/server/db/{client.ts,schema/*}` (đủ mọi bảng app + log + auth) + migration đầu tiên + hàm partition
  - `src/server/crypto/{secret-box,mcp-key}.ts`, `src/server/audit/{redact,cap-json}.ts`
  - `src/server/providers/{types,errors,money,dates,http,rate-limit,registry}.ts`
  - `src/server/mcp/types.ts` (McpGrant, Permission)
  - `src/lib/{format.ts,constants.ts}`, `src/lib/i18n/vi/*` (mỗi tính năng 1 file → tránh xung đột)
  - Vitest config, ESLint `no-restricted-imports`, scripts package.json
- Commit `main`.

## Đợt 1 — song song (6 agent, worktree)
| Agent | Vùng sở hữu | Kết quả |
|---|---|---|
| **ui-shell** | `src/components/app/**`, `src/app/globals.css`, `src/app/layout.tsx`, `src/app/(dashboard)/layout.tsx` (khung), `src/app/(dashboard)/dev/ui/**`, `src/lib/i18n/vi/common.ts`, `public/brand/**` | Token màu, glass, nút brand, AppShell (sidebar floating + top bar), PageHeader, GlassCard, KpiCard, EmptyState, StatusBadge, PlatformIcon/Badge, PermissionBadges, CopyField, SecretInput, ConfirmDialog, DataTable (TanStack v9, client + server mode), FilterBar, DateRangePicker, Stepper, JsonViewer, HelpPanel, ThemeToggle, TransparencyToggle, RelativeTime; trang demo `/dev/ui` |
| **auth** | `src/server/auth/**`, `src/server/services/{users,settings}.ts`, `src/server/audit/activity-log.ts`, `src/server/actions/{auth,users,settings,account}.ts`, `src/app/(auth)/**`, `src/app/api/auth/**`, `src/app/(dashboard)/{users,account,security}/**`, `src/proxy.ts`, `scripts/{cli,migrate}.ts`, `src/lib/i18n/vi/{auth,users,account}.ts` | Better Auth (2FA, admin, roles), /setup, /login, /login/2fa, đổi mật khẩu bắt buộc, cổng 2FA admin, /account, /users, CLI, ghi activity_logs |
| **provider-meta** | `src/server/providers/meta/**` | Adapter đầy đủ (validate, listAccounts, report, list/get, status, budget, update, copy, delete, upload, lookup, create campaign/adset/ad, targeting) + test MSW |
| **provider-openai** | `src/server/providers/openai-ads/**` | như trên (feature probe, conversions, DIY copy, create campaign/ad group/ad) |

Merge → orchestrator chạy typecheck/lint/test → sửa ghép nối → commit.

## Đợt 2 — song song (3 agent)
| Agent | Vùng sở hữu | Kết quả |
|---|---|---|
| **connections** | `src/server/services/{connections,ad-accounts}.ts`, `src/server/actions/connections.ts`, `src/app/(dashboard)/connections/**`, `src/lib/i18n/vi/connections.ts`, `scripts/worker.ts` + `src/server/jobs/{tokens-health,accounts-sync}.ts` | Danh sách, wizard thêm (HelpPanel từng nền tảng), chi tiết, kiểm tra lại, bật/tắt TKQC, worker pg-boss |
| **mcp-core** | `src/server/mcp/**` (trừ types.ts đã có), `src/app/mcp/**`, `src/server/audit/mcp-log-writer.ts`, `src/instrumentation.ts` | Endpoint, grant, handler SDK v2, registry, logging batch, confirm 2 bước, guardrail, **toàn bộ tool** (đọc + ghi + copy + create) gọi adapter |
| **mcp-admin** | `src/server/services/mcp-servers.ts`, `src/server/actions/mcp.ts`, `src/app/(dashboard)/mcp/**`, `src/lib/i18n/vi/mcp.ts` | Danh sách MCP, wizard 4 bước, màn hoàn tất + hướng dẫn 5 client, chi tiết (cấu hình, xoay key, xem lại link, tắt/xoá) |

## Đợt 3 — song song (2 agent)
| Agent | Vùng sở hữu | Kết quả |
|---|---|---|
| **logs-dashboard** | `src/server/services/{logs,dashboard}.ts`, `src/app/(dashboard)/{logs,page.tsx,settings}/**`, `src/server/jobs/{logs-maintain,logs-rollup,pending-cleanup}.ts`, `src/lib/i18n/vi/{logs,dashboard,settings}.ts` | Trang Nhật ký 2 tab + CSV, Tổng quan, Cài đặt, job retention |
| **deploy** | `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.dockerignore`, `README.md`, `docs/**`, `.github/**`, `scripts/gen-secrets.sh` | Đóng gói, README VI/EN, hướng dẫn lấy token từng nền tảng |

## Đợt 4 — Kiểm định chất lượng
- `security-reviewer`, `ads-api-reviewer` (mọi nền tảng đã phát hành), `ui-reviewer` (mọi trang) chạy song song → orchestrator tổng hợp → agent sửa lỗi theo nhóm.
- E2E Playwright luồng chính; build Docker + `docker compose up` thử; test thật với TKQC của chủ dự án (chỉ đọc trước, ghi trên object thử nghiệm).

## Hợp đồng chung (agent phải tuân theo)
- Import đường dẫn `@/…`. Server-only file có `import "server-only"` (trừ `providers/**`, `mcp/**`, `crypto/**`, `audit/redact.ts` để chạy được trong worker/test — dùng quy ước không import `next/*`).
- Chuỗi UI: `t.<feature>.<key>` từ `@/lib/i18n` (mỗi agent chỉ sửa file `vi/<feature>.ts` của mình).
- Kết quả server action: `{ ok: true, data } | { ok: false, error: string, fieldErrors?: Record<string,string> }`.
- Provider: implement `AdsProvider` trong `providers/types.ts`; đăng ký ở `providers/registry.ts` (orchestrator nối khi merge).
- Test: Vitest, file `*.test.ts` cạnh code; fixture trong `__fixtures__/`.
