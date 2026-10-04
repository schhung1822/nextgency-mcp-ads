---
name: db-change
description: Quy trình thay đổi schema PostgreSQL bằng Drizzle — thêm/sửa bảng, cột, index; xử lý riêng bảng log partition theo tháng; sinh và rà migration; cập nhật tài liệu schema. Dùng khi sửa src/server/db/schema/** hoặc thư mục drizzle/.
argument-hint: "<mô tả thay đổi>"
---

# Thay đổi DB: `$ARGUMENTS`

Đọc trước: `.claude/docs/03-database-schema.md`, `.claude/rules/database.md`.

1. **Thiết kế**: cột/kiểu/null/default, index cần cho truy vấn nào, ảnh hưởng tới dữ liệu cũ (backfill?), có chạm bảng log partition không, có chạm bảng Better Auth không (bảng auth → sửa config Better Auth rồi `npx auth@latest generate`, không sửa tay).
2. **Sửa schema** trong `src/server/db/schema/*.ts` (uuidv7 default, timestamptz, FK có index, CHECK cho trạng thái).
3. `pnpm db:generate --name <ten_ngan>` → **đọc SQL sinh ra**:
   - Bảng log mới: thêm `PARTITION BY RANGE ("created_at")` vào `CREATE TABLE`, PK gồm `created_at`; thêm partition default + gọi `app_ensure_monthly_partitions` trong migration custom (`drizzle-kit generate --custom`).
   - Thêm cột NOT NULL vào bảng có dữ liệu → cần default hoặc backfill nhiều bước.
   - Không `CREATE INDEX CONCURRENTLY` trên bảng cha partition.
   - Đổi tên cột: drizzle-kit có thể sinh drop+add → sửa thành `RENAME COLUMN`.
4. **Không sửa migration đã commit**; sai thì tạo migration mới.
5. Chạy migrate trên DB dev (`pnpm db:migrate` — hỏi trước), chạy test liên quan, kiểm tra `pnpm db:generate` lần nữa không còn diff.
6. Cập nhật `.claude/docs/03-database-schema.md` (bảng/cột/index mới, action log mới nếu có).
7. `/verify`.
