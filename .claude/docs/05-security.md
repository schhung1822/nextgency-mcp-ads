# Bảo mật

Ứng dụng giữ token có **toàn quyền chi tiền quảng cáo** của nhiều tài khoản → coi mọi lỗ hổng là nghiêm trọng. Mỗi PR chạm vào auth, crypto, MCP, log, server actions phải qua agent `security-reviewer`.

## 1. Xác thực (Better Auth 1.7.7)
Cấu hình chuẩn (`src/server/auth/auth.ts`):
```ts
export const auth = betterAuth({
  appName: "Ads MCP by noti.vn",
  baseURL: env.BETTER_AUTH_URL, trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 8, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true },
  disabledPaths: ["/sign-up/email", ...ADMIN_ENDPOINT_PATHS],   // mọi /admin/* → 404 qua HTTP
  databaseHooks: { user: { create: { before: /* mustChangePassword + createdById từ AsyncLocalStorage */ } } },
  user: { additionalFields: { mustChangePassword: { type: "boolean", defaultValue: false, input: false },
                              createdById: { type: "string", required: false, input: false } } },
  session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 30, freshAge: 60 * 10, cookieCache: { enabled: false } },
  rateLimit: { enabled: true, storage: "database", window: 60, max: 100,
    customRules: { "/sign-in/email": { window: 60, max: 5 }, "/two-factor/*": { window: 60, max: 5 } } },
  advanced: { useSecureCookies: true, ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
  hooks: { before: /* chặn admin tắt 2FA; chặn user bị khoá */, after: /* ghi activity_logs đăng nhập/2FA/đăng xuất */ },
  plugins: [
    twoFactor({ issuer: "Ads MCP (noti.vn)", totpOptions: { digits: 6, period: 30 },
      backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" }, trustDeviceMaxAge: 60 * 60 * 24 * 14 }),
    admin({ ac, roles: { admin: adminRole, staff: staffRole }, defaultRole: "staff", adminRoles: ["admin"],
            impersonationSessionDuration: 60 * 30 }),
    nextCookies(),   // luôn đứng cuối
  ],
});
```
- **Không có đăng ký**: `disableSignUp` + `disabledPaths`. User chỉ được tạo bởi `auth.api.createUser`.
- ⚠️ **`auth.api.createUser` gọi KHÔNG kèm `headers` sẽ BỎ QUA kiểm tra quyền** → trong server action LUÔN gọi `auth.api.createUser({ body, headers: await headers() })`. Gọi không headers bị hook **từ chối** trừ khi code server đánh dấu tin cậy bằng `runWithUserCreateContext({ kind: "setup" | "dev-seed" })` (AsyncLocalStorage — không thể đặt qua HTTP) hoặc bảng user còn rỗng. Chỉ `/setup` (đã kiểm tra `SETUP_TOKEN` + DB rỗng trong cùng transaction/advisory lock) và dev seed dùng cờ này; CLI `create-admin` ghi DB trực tiếp.
- **Endpoint admin của Better Auth qua HTTP luôn 404** (`/api/auth/admin/*`: set-role, set-user-password, create-user, list-user-sessions — trả cả session token!, …): app không dùng admin client trên trình duyệt; các endpoint này bỏ qua chính sách của users service (xác thực lại, xoá thiết bị tin cậy, mustChangePassword, createdById, NO_SELF, session_max_hours). Hai lớp: `disabledPaths` liệt kê đủ mọi đường dẫn admin (`ADMIN_ENDPOINT_PATHS` trong `guards.ts`) + hook `before` từ chối mọi lời gọi `/admin/*` có `ctx.request`. Gọi `auth.api.*` phía server (users service, kèm headers) vẫn qua guard của app.
- **Cờ user mới đặt ngay trong INSERT** (`databaseHooks.user.create.before`): `mustChangePassword`/`createdById` lấy từ ngữ cảnh `runWithUserCreateContext`; không có ngữ cảnh → mặc định an toàn `mustChangePassword=true`. Không còn khoảng hở "mật khẩu tạm chưa bị đánh dấu". Các lời gọi Better Auth vẫn không chung transaction với app (createUser, setRole, setUserPassword, ban/unban, removeUser — dùng connection riêng): chạy trong `withUserGuard` (advisory lock + kiểm tra) và log ngay sau; nếu ghi log lỗi thì thao tác Better Auth đã xảy ra và được ghi `failure`.
- **Chính sách 2FA** (`src/server/auth/two-factor-policy.ts`, quyết định chủ dự án 2026-10-02): 2FA **tuỳ chọn, mặc định tắt** cho mọi người. Setting `require_2fa_admin` (mặc định false) bắt buộc với admin, `require_2fa_all` (mặc định false) bắt buộc với mọi người. Khi bắt buộc: `requireUser()`/`requireUserForAction()` chuyển/chặn người chưa bật về `/security/enable-2fa`, hook `before` cấm tắt 2FA, guard admin + luật "còn ≥1 admin" chỉ tính admin có 2FA. Đọc setting lỗi → coi như bắt buộc (fail closed). **Khuyến nghị bật `require_2fa_admin` trước khi đưa lên máy chủ thật.**
- Luồng bật 2FA: `twoFactor.enable({ password })` → QR (render client bằng `qrcode.react`) → `verifyTotp({ code })` → hiện 10 mã dự phòng **một lần** (cho tải .txt).
- Đăng nhập có 2FA: sign-in trả `twoFactorRedirect: true` → `/login/2fa` (OTP 6 số `input-otp` hoặc mã dự phòng; tuỳ chọn "tin thiết bị này 14 ngày" — **ẩn với admin**).
- **Bề mặt HTTP của Better Auth chỉ gồm những gì trình duyệt dùng**: `/api/auth/` chỉ nhận `sign-in/email`, `two-factor/verify-totp`, `two-factor/verify-backup-code`, `sign-out`, `get-session`, `ok` (allowlist `HTTP_ALLOWED_PATHS` trong `hooks.ts`, kiểm tra ở hook `before`); mọi đường dẫn khác → 404. Lý do: `change-password`, `update-user`, `revoke-*`, `list-sessions`, `two-factor/enable|disable|generate-backup-codes|get-totp-uri`… có bản server action mang chính sách của app (ngân sách sai mật khẩu dùng chung, nhật ký, `mustChangePassword`, chính sách 2FA) mà gọi thẳng HTTP với cookie phiên sẽ bỏ qua (và `change-password` qua HTTP là một "oracle" đoán mật khẩu ngoài ngân sách 5 lần/15 phút). Gọi `auth.api.*` phía server (không có `Request`) không bị ảnh hưởng.
- **Khoá đăng nhập (bước mật khẩu)** — Better Auth không có lockout theo email → `lockout.ts` + hook `/sign-in/email` + rate limit theo IP sẵn có (5 lần/phút/IP). **Thiết kế (M3, cập nhật 2026-10-03 sau quyết định "2FA tuỳ chọn, mặc định tắt"): kẻ tấn công chưa đăng nhập không được khoá chủ hệ thống ra ngoài** — vì admin duy nhất mặc định chỉ có mật khẩu, khoá theo email với ngưỡng 10 lần từ bất kỳ IP nào cho phép bất kỳ ai trên internet khoá chủ hệ thống mỗi 15 phút. Mỗi lần sai đếm 2 bộ đếm (bảng `verification`): theo (email, IP client = hop đầu X-Forwarded-For do Caddy ghi đè) và theo email.
  - Theo **(email, IP)**: 10 lần sai/15 phút → IP đó bị khoá 15 phút với email đó. Luôn áp dụng. Một IP tấn công chỉ khoá được chính nó.
  - Theo **email** (mọi IP): chỉ cho tài khoản **không có 2FA**, ngưỡng **50** lần sai/15 phút (phát hiện đoán mật khẩu phân tán), khoá 15 phút. **Không bao giờ từ chối một IP đã đăng nhập thành công vào tài khoản đó trong 30 ngày** (tra `activity_logs` `auth.login.success`; IP lấy từ header proxy nên kẻ tấn công không giả mạo được) — chủ hệ thống ở nơi quen thuộc luôn vào được, kể cả đang bị tấn công phân tán.
  - Tài khoản **có 2FA**: chỉ áp dụng khoá theo (email, IP); bước TOTP có lockout riêng của Better Auth (10 lần sai → 15 phút) và cần mật khẩu đúng trước.
  - Mật khẩu đúng xoá mọi bộ đếm của email. Gỡ khoá thủ công: `node dist/cli.mjs unlock <email>` (xoá mọi bộ đếm + reset khoá 2FA, ghi `user.update` `op: unlock`).
  - Đánh đổi đã chấp nhận: kẻ tấn công có nhiều IP (đặc biệt IPv6) vẫn đạt 50 lần/15 phút/tài khoản không 2FA để khoá người dùng ở IP **mới** 15 phút (chủ hệ thống ở IP quen không bị ảnh hưởng); có thể phân biệt "email này có 2FA" khi đổi IP (lộ nhẹ). **Khuyến nghị bật 2FA cho admin** (Cài đặt → "Bắt buộc 2FA cho quản trị viên") khi đưa lên máy chủ thật.
- `mustChangePassword` (user do admin tạo / admin đặt lại) → mọi trang chuyển về đổi mật khẩu.
- Luôn còn ≥1 admin active, có 2FA; admin không tự hạ quyền/khoá/xoá chính mình. `allowImpersonatingAdmins` để mặc định (tắt); impersonation ghi log.
- Phiên: 12 giờ, gia hạn mỗi 30 phút hoạt động (trần tuyệt đối theo setting `session_max_hours`).
- **Xác thực lại (re-auth) dùng chung** — `src/server/auth/reauth.ts` (`withReauth` / `requireReauth` + `requestReauthVerifier`): mật khẩu (Better Auth `verifyPassword`) + TOTP khi user đã bật 2FA. Gọi `auth.api.*` phía server không qua rate limit HTTP của Better Auth → **mọi** lần kiểm tra mật khẩu trong server action đi qua cổng này: **5 lần sai / 15 phút / người, tính chung mọi thao tác** (đếm dòng `activity_logs` `status=failure` có `metadata.reauth=true`, ghi dưới action của thao tác được bảo vệ), khoá advisory theo user chống chạy song song. Áp dụng cho: **tạo MCP** (wizard bước 4 mở hộp xác thực), xem lại link, xoay key; **tạo admin**; **đặt lại mật khẩu / 2FA của một admin**; **đổi vai trò**; **thay token kết nối**; **đổi mật khẩu**, bắt đầu bật 2FA, tắt 2FA, **tạo lại mã dự phòng** (mật khẩu + TOTP); **xuất CSV** khi phiên không còn fresh. Re-auth thành công đánh dấu phiên "fresh" 10 phút (bảng `verification`, id băm theo session).
- **Xuất CSV** (`POST /api/logs/export`): chỉ POST (GET cross-site mang cookie SameSite=Lax), kiểm tra `Origin` = app + `Sec-Fetch-Site: same-origin` nếu có; phiên fresh (đăng nhập ≤10 phút hoặc vừa re-auth ≤10 phút) hoặc nhập lại mật khẩu/TOTP; hạn mức **5 lần xuất / 10 phút / người** (`src/server/db/quota.ts`).
- Cookie: `Secure`, `HttpOnly`, `SameSite=Lax` (mặc định Better Auth) — chỉ chạy sau HTTPS.

## 2. Phân quyền
- `src/server/auth/permissions.ts` (`createAccessControl`): statement `connection`, `mcp`, `log`, `setting`, `user` + vai trò `admin` / `staff`.
- **Mọi** server action / route handler / service: `requireUser()` → kiểm tra role → **kiểm tra quyền sở hữu** (`owner_id === session.user.id` trừ admin). Không tin id/owner từ client. Truy vấn danh sách của staff luôn `WHERE owner_id = $me`.
- Layout không phải ranh giới bảo mật — kiểm tra lại trong action.
- Server action dùng zod parse input; trả lỗi tiếng Việt chung chung, không lộ chi tiết nội bộ.

## 3. Mã hoá bí mật lưu trữ
- AES-256-GCM, keyring env `ENCRYPTION_KEYS="2:<b64 32B>,1:<b64 32B>"` (key đầu = active; còn lại chỉ để giải mã). Định dạng `v<ver>.<iv b64url>.<tag>.<ct>`; IV 12 byte ngẫu nhiên mỗi lần; **AAD** gắn với dòng + trường (`connection:<id>:credentials`, `mcp:<id>:key`) để không tráo ciphertext giữa các dòng.
- Code tham chiếu: `src/server/crypto/secret-box.ts` (`encryptSecret`, `decryptSecret`, `needsReencrypt`). Xoay khoá: thêm key mới lên đầu → deploy → job `tokens.reencrypt` → xác minh → bỏ key cũ.
- Credential **không bao giờ** trả về trình duyệt sau khi lưu (form sửa = nhập lại; UI chỉ hiện `credential_hint`). Không đưa credential vào props của client component, không log, không trả cho AI.
- `MCP_KEY_PEPPER` (32 byte) cho HMAC key MCP. `BETTER_AUTH_SECRET` (mã hoá TOTP secret, ký cookie) — xoay bằng `BETTER_AUTH_SECRETS`.
- **Sao lưu khoá tách biệt với file dump DB.** Mất `ENCRYPTION_KEYS` = mất toàn bộ credential (phải dán lại).

## 4. MCP endpoint
- Key 256-bit ngẫu nhiên; DB chỉ lưu HMAC + prefix + bản mã hoá (D1). So khớp bằng tra cứu hash (không so chuỗi thô).
- Key sai/tắt/hết hạn → **404** (không 401, không phân biệt lý do). Rate limit theo IP cho các lần 404 (chống dò key) + theo MCP.
- Kiểm tra `Host` (= `APP_DOMAIN`) và `Origin` (nếu có header Origin mà không thuộc allowlist → 403). Request server-to-server không có Origin thì cho qua.
- Mỗi tool **tự kiểm tra lại** platform/account/quyền với grant — không tin enum schema hay input.
- Credential nền tảng chỉ giải mã trong phạm vi request, không cache plaintext lâu hơn request.
- Văn bản từ nền tảng (tên/nội dung quảng cáo, comment) là dữ liệu không tin cậy (prompt injection) → không đưa vào `instructions`, không diễn giải như lệnh; tool không có khả năng đọc file/URL tuỳ ý ngoài `ads_upload_media` (chỉ http/https công khai, chặn IP nội bộ/localhost/metadata 169.254.169.254, giới hạn kích thước & thời gian — chống SSRF).
- Che key trong mọi log: Caddy log filter (`/mcp/[redacted]`), log ứng dụng chỉ ghi `mcp_id`/`key_prefix`, header `Referrer-Policy: no-referrer` trên `/mcp/*`.
- Guardrail ghi: xác nhận 2 bước, giới hạn % thay đổi ngân sách, trần ngân sách, object mới luôn tạm dừng, quyền `delete` mặc định tắt (xem `04-mcp-design.md` §6).

## 5. Redact trước khi ghi log
`src/server/audit/redact.ts`:
- Key nhạy cảm (regex tên khoá, không phân biệt hoa thường): `authorization|cookie|set-cookie|password|secret|client_secret|app_secret|access_token|refresh_token|id_token|token|api_?key|x-api-key|private_key|service_account_json|credentials` → `"[redacted]"`.
- Mẫu giá trị: `EAA[A-Za-z0-9]{20,}` (Meta), `sk-(proj-|svcacct-|admin-)?…` (OpenAI), `Bearer …`, `-----BEGIN PRIVATE KEY-----…`, `amcp_[A-Za-z0-9_-]{20,}` (key MCP của chính app).
- Áp dụng cho: args/response trong `mcp_call_logs`, `metadata` trong `activity_logs`, lỗi gửi ra stdout.
- Lỗi ra stdout luôn qua `safeErrorForLog(e)` (`src/server/audit/safe-error.ts`): tên + code + message đã redact, **cắt phần `params:`** của lỗi Drizzle (tham số có thể là ciphertext, email, args MCP) và không in `detail` của Postgres. Postgres chạy với `log_parameter_max_length=0` và `log_parameter_max_length_on_error=0` (không ghi bind parameter vào log DB, kể cả câu chậm > 500 ms).
- Giới hạn kích thước (16 KB request / 32 KB response) qua `capJson()`.

## 6. Web hardening
- Header (Caddy + `next.config`): HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `poweredByHeader: false`, **CSP**: `default-src 'self'; script-src 'self' 'unsafe-inline'` (+`'unsafe-eval'` chỉ ở dev)`; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Không dùng nonce (sẽ buộc mọi trang render động + đổi proxy) — app không nhúng nội dung bên thứ ba và không `dangerouslySetInnerHTML` dữ liệu người dùng.
- Server Actions của Next tự so `Origin` với host (`x-forwarded-host`/`host`); Caddy chuyển nguyên Host công khai nên **không cần** `serverActions.allowedOrigins` (mặc định "chỉ cùng origin" là chặt nhất; giá trị này cố định lúc build nên không đọc `APP_DOMAIN`). Route handler dùng cookie có thao tác nhạy cảm tự kiểm tra Origin (`src/server/net/same-origin.ts`).
- **Production bắt buộc `BETTER_AUTH_URL` https://** (ngoại lệ loopback để thử nghiệm local); `env()` được kiểm tra ngay lúc khởi động (instrumentation) ở production.
- `SETUP_TOKEN` (nếu đặt) **≥ 24 ký tự**; `/setup` giới hạn **10 lần thử / 15 phút / IP**.
- Script dev seed (`scripts/dev-seed-logs.ts`, `src/server/mcp/__dev__/seed.ts`) chỉ chạy khi `ALLOW_DEV_SEED=1`, `DATABASE_URL` trỏ localhost/127.0.0.1/::1, không phải production và DB không có user ngoài `@example.test`.
- CLI: không đặt mật khẩu/secret trên dòng lệnh (lộ qua `ps`/lịch sử shell) — `ADMIN_PASSWORD` hoặc stdin/nhập ẩn; argv vẫn chạy nhưng cảnh báo.
- Không `dangerouslySetInnerHTML` với dữ liệu người dùng/nền tảng. Hiển thị JSON log bằng component escape sẵn.
- Upload: v1 không nhận file từ trình duyệt (chỉ URL media qua MCP).
- `/setup` tự vô hiệu khi đã có user; so `SETUP_TOKEN` bằng `timingSafeEqual`.
- Endpoint `/api/health` không lộ version/thông tin nội bộ.

## 7. Hạ tầng
- Chỉ Caddy mở cổng 80/443; Postgres không publish port; container web/worker chạy user `node` (không root; ngoại lệ duy nhất là `updater`, xem bên dưới).
- `.env` không commit; `.env.example` chỉ có placeholder. Sinh secret bằng `openssl rand -base64 32`.
- Cập nhật bảo mật: theo dõi Next.js security release (16.3.8 vá SSRF image optimizer — không cấu hình `remotePatterns`), Better Auth, Postgres minor.
- Backup DB mã hoá khi đẩy off-site; test restore định kỳ.
- **`docker.sock` chỉ ở service `updater`** (root-equivalent trên máy chủ): web/worker không bao giờ mount. Updater không nhận kết nối vào, chỉ đọc bảng `system_update_requests`, chạy lệnh bằng `spawn(args[])` với `target_version` đã kiểm tra (`x.y.z`, mới hơn bản đang chạy) và image cố định; `read_only`, `cap_drop: ALL` (+CHOWN/DAC_OVERRIDE/FOWNER), `no-new-privileges`; log redact (không có `.env`/token). Chi tiết và cách tắt: 07-deployment.md §6.4.

### Cập nhật hệ thống (`10-update-system.md`)
- **Ai được làm**: chỉ **admin**. Kiểm tra bản mới ("Kiểm tra ngay"), xem trạng thái (`GET /api/updates/status`), bấm "Cập nhật" đều kiểm tra role ở **3 tầng**: layout `settings` (HTTP 404 thật cho nhân viên), page/route/action (`requireAdmin()` / `requireUserForAction({ role: "admin" })`) và service (`assertAdmin`, từ chối ngay cả khi tầng trên sót). Nhân viên chỉ thấy **số phiên bản** trong menu người dùng; route `/settings/updates` và `/api/updates/status` trả 404, action trả lỗi quyền.
- **Re-auth**: "Cập nhật" đi qua `withReauth` (mật khẩu + TOTP nếu bật 2FA, chung ngân sách 5 lần sai / 15 phút); yêu cầu + `activity_logs` (`system.update_requested`) ghi **cùng transaction**. "Kiểm tra ngay" không cần re-auth (chỉ đọc GitHub) nhưng có hạn mức 6 lần / phút / người và ghi `system.update_check`.
- **Không tin client**: `targetVersion` phải là semver chặt `X.Y.Z` **và bằng** `update_latest.version` do server tự lấy từ GitHub; phải mới hơn bản đang chạy; bản `dev` không cập nhật tự động; chỉ 1 yêu cầu mở tại một thời điểm (partial unique index, an toàn khi hai admin bấm cùng lúc); chỉ cho gửi khi heartbeat `updater` < 90 s.
- **Web KHÔNG BAO GIỜ có `docker.sock`** (cũng không quyền Docker nào khác). Web chỉ ghi 1 dòng `system_update_requests`; service `updater` riêng (không publish port) poll DB và chạy docker. `updater` tự kiểm tra `target_version` đúng `^\d+\.\d+\.\d+$`, lớn hơn bản đang chạy và dùng image cố định `ghcr.io/notivn/ads-mcp-simple:<ver>`; không nhận chuỗi tự do từ DB.
- **GitHub token** (`UPDATE_GITHUB_TOKEN`, tuỳ chọn, fine-grained chỉ đọc cho kho riêng tư): chỉ nằm trong header `Authorization`, không vào DB/log/thông báo lỗi (thông báo lỗi là chuỗi cố định của app, không chép nội dung phản hồi GitHub). `UPDATE_REPO` được kiểm tra định dạng `chủ/kho` trước khi ghép URL. Xác thực `docker login ghcr.io` để kéo image nằm ở máy chủ, không vào DB.
- **Dữ liệu từ GitHub là không tin cậy**: ghi chú phát hành cắt 4000 ký tự, bỏ ký tự điều khiển, hiển thị **dạng text đã escape** (không HTML/Markdown); liên kết chỉ nhận `https://github.com/…`.
- Cột `system_update_requests.log` có thể chứa đầu ra kỹ thuật (đã redact bởi `updater`): web không đọc và không trả cột này ra giao diện.

## 8. Checklist review bảo mật (dùng cho agent `security-reviewer`)
- [ ] Mọi action/route có `requireUser` + kiểm tra role + kiểm tra owner
- [ ] Không gọi `auth.api.*` admin mà thiếu `headers` (ngoại lệ duy nhất: `runWithUserCreateContext` ở /setup, dev seed)
- [ ] Không mở thêm endpoint Better Auth qua HTTP: thêm vào `HTTP_ALLOWED_PATHS` chỉ khi trình duyệt thật sự cần và đã xét chính sách (re-auth, nhật ký, 2FA)
- [ ] Trang/route quản trị mới: đặt `requireAdmin()` trong `layout.tsx` NGOÀI ranh giới `loading.tsx` (nhân viên nhận HTTP 404 thật) + kiểm tra lại trong page/action; thêm vào ma trận `tests/e2e/authz-matrix.spec.ts` và `src/server/__tests__/people/authz-matrix.test.ts`
- [ ] Thao tác nhạy cảm mới → qua `withReauth`/`requireReauth` (không tự gọi `verifyPassword`)
- [ ] Lỗi ra stdout dùng `safeErrorForLog`; route handler cookie + thao tác nhạy cảm: POST + kiểm tra Origin
- [ ] Không trả credential/key/ciphertext ra client hoặc AI; không log
- [ ] zod validate mọi input (server action, route, MCP tool)
- [ ] MCP: 404 cho key sai, kiểm tra grant trong từng tool, guardrail ghi, xác nhận 2 bước
- [ ] Redact + cap trước khi ghi log
- [ ] SQL chỉ qua Drizzle/`sql` template (không nối chuỗi); tên partition qua `format('%I')`
- [ ] Fetch URL ngoài có chặn SSRF + timeout
- [ ] activity_logs ghi trong cùng transaction với thao tác
- [ ] Không thêm `NEXT_PUBLIC_*` chứa bí mật
- [ ] Không mount `docker.sock` (hay cấp quyền Docker) cho container `web`/`worker`; việc cập nhật chỉ qua dòng `system_update_requests` + service `updater`
