---
paths:
  - "src/server/actions/**"
  - "src/server/services/**"
  - "src/server/auth/**"
  - "src/app/**/actions.ts"
  - "src/app/api/**"
  - "src/app/(auth)/**"
  - "src/proxy.ts"
  - "scripts/cli.ts"
---

# Quy tắc server action / service / auth (đọc kèm `.claude/docs/05-security.md`)

Khuôn mẫu server action (mỏng, logic nằm ở service):
```ts
"use server";
export async function updateConnection(input: unknown) {
  const session = await requireUser();                 // redirect nếu chưa đăng nhập / admin chưa 2FA
  const data = updateConnectionSchema.parse(input);    // zod, thông báo tiếng Việt
  const result = await connectionsService.update(session, data);   // service kiểm tra owner + ghi activity_logs trong transaction
  revalidatePath("/connections");
  return { ok: true, data: result } as const;          // hoặc { ok: false, error: "<tiếng Việt>" }
}
```
- **Luôn**: `requireUser()` (hoặc `requireAdmin()`) → zod parse → service. Service tự kiểm tra **quyền sở hữu** (`owner_id`) — staff chỉ đọc/ghi tài nguyên của mình; admin thấy tất cả. Không nhận `ownerId`/`role` từ client.
- Gọi API admin của Better Auth (`createUser`, `setRole`, `banUser`, `setUserPassword`, `revokeUserSessions`…) **bắt buộc** kèm `headers: await headers()`. Ngoại lệ duy nhất: `/setup` (đã khoá bằng SETUP_TOKEN + DB rỗng, chạy trong `runWithUserCreateContext({ kind: "setup" })`) — CLI `create-admin` ghi DB trực tiếp.
- Mọi thay đổi dữ liệu nghiệp vụ ghi `activity_logs` **trong cùng transaction** (`action` theo danh mục ở 03-database-schema.md §4, `metadata` = diff đã redact).
- Thao tác nhạy cảm (tạo/xem lại/xoay MCP, thay credential, đổi role, tạo admin, đặt lại mật khẩu/2FA của admin, đổi mật khẩu/mã dự phòng, xuất log) đi qua cổng re-auth chung `src/server/auth/reauth.ts` (`requireReauth`/`withReauth` + `requestReauthVerifier`) — KHÔNG tự gọi `auth.api.verifyPassword` (bỏ qua bộ đếm sai + log).
- Endpoint admin của Better Auth không dùng qua HTTP (404); `createUser` không headers chỉ trong `runWithUserCreateContext`.
- Log lỗi ra stdout bằng `safeErrorForLog(e)`, không `e.message` thô (lỗi Drizzle chứa params).
- Không bao giờ trả credential/ciphertext/key MCP trong kết quả action (trừ link MCP ngay lúc tạo hoặc khi "xem lại" hợp lệ).
- Lỗi trả về người dùng: tiếng Việt, chung chung; chi tiết kỹ thuật chỉ ghi server log (đã redact).
- Next 16: `await headers()`, `await cookies()`, `await params`. `proxy.ts` chỉ redirect lạc quan theo cookie; matcher **loại trừ** `/mcp`, `/api/auth`, `/api/health`, `/login`, `/setup`, `/_next`, file tĩnh.
- Admin bắt buộc 2FA (cổng ở `requireUser`); không cho admin tắt 2FA; luôn còn ≥1 admin active; không tự hạ quyền/khoá/xoá chính mình.
