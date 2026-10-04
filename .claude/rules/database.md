---
paths:
  - "src/server/db/**"
  - "drizzle/**"
  - "drizzle.config.ts"
  - "scripts/migrate.ts"
---

# Quy tắc database (đọc kèm `.claude/docs/03-database-schema.md`)

- Drizzle ORM 0.45.x + drizzle-kit 0.31.x (KHÔNG 1.0-rc). PostgreSQL 18. Schema chia file: `schema/auth.ts` (sinh bởi `npx auth@latest generate` — không viết tay), `schema/app.ts`, `schema/logs.ts`.
- Bảng app: `uuid` PK mặc định `sql\`uuidv7()\``; `timestamptz` (UTC); `created_at`/`updated_at`; soft delete `deleted_at` cho `connections`, `mcp_servers`. FK luôn có index. Trạng thái dùng `text` + CHECK hoặc `pgEnum` cho tập ổn định (`platform`).
- Thay đổi schema: sửa file schema → `pnpm db:generate` → **đọc lại SQL sinh ra** → commit. Không dùng `drizzle-kit push` ngoài dev. **Không sửa migration đã commit**; tạo migration mới.
- Bảng log (`mcp_call_logs`, `activity_logs`) là bảng **partition theo tháng**: sau khi generate phải **sửa tay** `CREATE TABLE` thêm `PARTITION BY RANGE ("created_at")`; PK phải chứa `created_at`; không FK từ bảng log sang bảng khác (log phải sống sau khi đối tượng bị xoá → lưu snapshot). Không `CREATE INDEX CONCURRENTLY` trên bảng cha. Bảng log tối đa ~5 index.
- `drizzle.config.ts`: `schemaFilter: ["public"]` (bỏ schema `pgboss`), `tablesFilter: ["*", "!*_p2*", "!*_default"]` (bỏ partition con).
- Truy vấn: chỉ qua query builder hoặc template `sql\`\`` (tham số hoá). Identifier động (tên partition) chỉ trong PL/pgSQL với `format('%I')`.
- Query danh sách log: bắt buộc điều kiện thời gian, keyset `(created_at, id)`, không select cột jsonb lớn, không `count(*)` chính xác.
- Transaction cho mọi thao tác nhiều bước + ghi `activity_logs` cùng transaction.
- Script migrate (`scripts/migrate.ts`) dùng `pg_advisory_lock(7272701)` rồi `migrate()` rồi `app_ensure_monthly_partitions(...)`.
