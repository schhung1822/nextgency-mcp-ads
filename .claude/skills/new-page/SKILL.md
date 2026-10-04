---
name: new-page
description: Dựng một trang quản trị mới (hoặc làm lại trang) theo design system Shopify + Liquid Glass của dự án — PageHeader, dữ liệu từ service, phân quyền, trạng thái loading/empty/error, chuỗi tiếng Việt, kiểm tra sáng/tối/mobile. Dùng khi tạo/sửa trang trong src/app/(dashboard)/.
argument-hint: "<route> [mô tả]"
---

# Trang mới: `$ARGUMENTS`

Đọc trước: `.claude/docs/06-ui-design-system.md` (§5–8, wireframe của trang nếu có), `.claude/docs/01-product-spec.md` (chức năng + ma trận quyền), `.claude/rules/ui.md`.

## Các bước
1. **Phạm vi & quyền**: ai được vào (admin/staff)? staff thấy dữ liệu gì (chỉ của mình)? Hành động chính duy nhất của trang là gì?
2. **Server**: `page.tsx` là Server Component → `await requireUser()` (hoặc `requireAdmin()`) → gọi `src/server/services/*` (lọc owner) → truyền dữ liệu **đã lọc, không chứa secret** xuống client component.
3. **Bố cục**:
   - `PageHeader` (tiêu đề, 1 câu mô tả, nút chính `variant="brand"`, dropdown "Thêm" cho hành động phụ, breadcrumb nếu là trang con).
   - Nội dung: `Card` đặc (1 cột, hoặc 2/3 + 1/3); danh sách → `DataTable` + `FilterBar` + Tabs view; KPI → `KpiCard` (glass).
   - `loading.tsx` dùng `Skeleton`; trạng thái rỗng `EmptyState` có CTA; lỗi → thông điệp tiếng Việt + cách sửa.
4. **Tương tác**: form = shadcn `field` + RHF + zod (schema chung ở `src/lib/schemas/`); submit → server action (theo `.claude/rules/server-and-auth.md`) → toast `sonner`; thao tác nguy hiểm → `ConfirmDialog`; form dài → contextual save bar.
5. **Chuỗi**: thêm vào `src/lib/i18n/vi.ts` theo thuật ngữ chuẩn; định dạng tiền/ngày bằng `src/lib/format.ts`.
6. **Điều hướng**: thêm mục sidebar (ẩn với staff nếu chỉ admin), tiêu đề `<Tên> · Ads MCP` qua `metadata`.
7. **Kiểm tra**: `pnpm dev` → Chrome DevTools MCP chụp sáng/tối × 390px/1440px; bấm thử luồng chính; console sạch; đăng nhập bằng staff để kiểm tra phân quyền (không thấy dữ liệu người khác, không thấy nút admin). Gọi agent `ui-reviewer` cho trang mới.
8. `/verify`.
