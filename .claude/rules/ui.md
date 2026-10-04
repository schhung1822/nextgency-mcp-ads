---
paths:
  - "src/app/**/*.tsx"
  - "src/components/**"
  - "src/app/globals.css"
  - "src/lib/i18n/**"
  - "src/lib/format.ts"
---

# Quy tắc UI (đọc kèm `.claude/docs/06-ui-design-system.md`)

- Dùng component shadcn/ui có sẵn (`pnpm dlx shadcn@latest add <name>`). Không viết lại Button/Dialog/Table… Chỉ thêm variant (vd `brand` trong button.tsx). Không sửa tay logic của file trong `components/ui/` trừ khi bắt buộc — ghi chú lý do.
- Bố cục kiểu Shopify: mỗi trang có `PageHeader` (tiêu đề + 1 câu mô tả + **đúng 1 nút chính `variant="brand"`** góc phải; hành động phụ vào dropdown "Thêm").
- Liquid Glass (`glass`/`glass-strong`) **chỉ** cho: top bar, sidebar floating, popover/dropdown/dialog/sheet, thanh hành động nổi, KPI card, màn đăng nhập. Bảng, form, JSON → `Card` đặc. Không glass lồng glass. Không animate backdrop-filter.
- Màu: không hard-code hex trong component — dùng token (`bg-primary`, `text-brand-red`, `from-primary-from`…). `#ED3C47` không làm nền chữ trắng.
- Mọi chuỗi hiển thị lấy từ `src/lib/i18n/vi.ts`, tiếng Việt có dấu, thuật ngữ theo bảng ở 06-ui-design-system.md §8. Tiền/ngày qua `src/lib/format.ts` (vi-VN, `Asia/Ho_Chi_Minh`).
- Server Component mặc định; `"use client"` chỉ khi cần state/sự kiện. Client component **không** import `@/server/*`; gọi server action.
- Form: shadcn `field` + react-hook-form `Controller` + zodResolver (zod v4, `z.config(z.locales.vi())`). Schema zod dùng chung client/server đặt ở `src/lib/schemas/`.
- Bảng: TanStack Table **v9** (`useTable`, `tableFeatures`) — bảng log dùng chế độ server-side + keyset pagination, không client row model.
- Trạng thái: luôn có loading (`Skeleton`), empty (`Empty` + CTA), error (thông điệp tiếng Việt + cách sửa). Toast bằng `sonner`.
- Thao tác nguy hiểm (xoá, xoay key, đặt lại 2FA) → `ConfirmDialog`; xoá cần gõ tên để xác nhận.
- Secret: `SecretInput` không bao giờ prefill giá trị đã lưu; chỉ hiện `credential_hint`.
- Trợ năng: `aria-label` tiếng Việt cho nút chỉ có icon, focus ring thấy rõ, AA contrast ở cả sáng/tối, tôn trọng reduced-motion/transparency.
- Trước khi báo xong một trang: chụp màn hình sáng + tối, 390px + 1440px (Chrome DevTools MCP) và tự soát theo checklist trong agent `ui-reviewer`.
