# 10 - Hệ thống phiên bản & cập nhật tự động (admin)

> Yêu cầu của chủ dự án (2026-10-03): đẩy dự án lên GitHub, phát hành bằng **tag** (`vMAJOR.MINOR.PATCH`). Trong web hiển thị **số phiên bản**; có bản mới thì **admin** thấy thông báo; **chỉ admin** bấm "Cập nhật" và hệ thống tự cập nhật. Nhân viên chỉ thấy số phiên bản.

## 1. Nguyên tắc

1. **Container `web` KHÔNG BAO GIỜ được mount `docker.sock`.** Việc chạy docker nằm ở service riêng `updater` (không publish port, không nhận kết nối vào). Web chỉ ghi 1 dòng yêu cầu vào DB; `updater` poll DB và thực thi.
2. `updater` chỉ chấp nhận `target_version` đúng regex `^\d+\.\d+\.\d+$`, **lớn hơn** phiên bản đang chạy, và image luôn là `ghcr.io/notivn/ads-mcp-simple:<version>` (repo cố định, không nhận chuỗi tự do từ DB; bản fork đổi bằng biến môi trường `APP_IMAGE` của chính updater/compose, được kiểm tra định dạng, không bao giờ từ DB).
3. Server action cập nhật: `requireAdmin()` + **re-auth** (cổng `src/server/auth/reauth.ts`) + `target_version` phải **bằng** `update_latest.version` do server tự kiểm tra (không tin chuỗi từ client) + ghi `activity_logs` cùng transaction.
4. Luôn **sao lưu DB trước khi cập nhật** và **migrate bằng image mới trước khi thay `web`/`worker`**; lỗi ở bất kỳ bước nào → không đụng vào bản đang chạy hoặc rollback về bản cũ. Migration phải tương thích ngược 1 phiên bản (expand/contract) vì rollback không đảo migration (ghi vào 08-roadmap/07-deployment).
5. Repo GitHub có thể **private**: kiểm tra phiên bản dùng `UPDATE_GITHUB_TOKEN` (tuỳ chọn; repo private: Token B = PAT classic `repo` của tài khoản outside collaborator chỉ có quyền Read - PAT fine-grained không dùng được cho outside collaborator), kéo image GHCR dùng `docker login ghcr.io` đã làm sẵn trên VPS (Token A = PAT classic `read:packages`; credentials nằm ở máy chủ, không vào DB/log).
6. **Chỉ chạy image có chữ ký số của noti.vn**: sau khi kéo image đích (và image updater mới khi tự thay), updater chạy `cosign verify` với danh tính chính xác `https://github.com/notivn/Ads-MCP-simple/.github/workflows/docker.yml@refs/tags/v<target>` + issuer `https://token.actions.githubusercontent.com`. Không đạt (không có chữ ký, ký cho tag khác, không tới được Sigstore) → `failed` ở step `pull` (không thêm step mới để DB/UI/web cũ vẫn tương thích), bản đang chạy không bị đụng. Bỏ qua khi `APP_IMAGE` khác image mặc định (fork/registry riêng) hoặc `.env` có `UPDATER_VERIFY_SIGNATURE=0` (có ghi log). Chi tiết: `07-deployment.md` §0b.

## 2. Luồng

```
git tag v1.2.0 && git push --tags
  └─ GitHub Actions: build image ghcr.io/notivn/ads-mcp-simple:1.2.0 (+ updater image), ký cosign keyless, tạo GitHub Release (ghi chú)
worker job `update-check` (6 giờ/lần + nút "Kiểm tra ngay" + tự kiểm tra mỗi lần admin mở `/settings/updates`)
  └─ GitHub API → app_settings.update_latest
admin mở /settings/updates → thấy "Có bản mới v1.2.0" → bấm Cập nhật → re-auth
  └─ web: INSERT system_update_requests(status=pending)
updater (poll 5s) nhận yêu cầu → running:
  backup → pull (+ kiểm APP_BUILD_VERSION + cosign verify) → migrate (image mới, one-shot) → ghi APP_VERSION vào .env → up -d web worker → healthcheck
  ├─ ok  → succeeded (+ activity log)
  └─ lỗi → rollback về from_version → rolled_back / failed (+ activity log)
UI poll /api/updates/status (chịu được lúc web khởi động lại) → tự tải lại khi version khớp
```

## 3. Hợp đồng dữ liệu (app ↔ updater)

**Bảng `system_update_requests`** (Drizzle migration mới, không partition):

| cột                                                     | kiểu                     | ghi chú                                                                  |
| ------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `id`                                                    | uuid v7 PK               |                                                                          |
| `from_version`                                          | text                     | phiên bản đang chạy lúc yêu cầu                                          |
| `target_version`                                        | text                     | semver không có `v`                                                      |
| `status`                                                | text                     | `pending` · `running` · `succeeded` · `failed` · `rolled_back` (CHECK)   |
| `step`                                                  | text null                | `backup` · `pull` · `migrate` · `restart` · `healthcheck` · `rollback`   |
| `message`                                               | text null                | ngắn, tiếng Việt, đã redact (hiện trên UI)                               |
| `log`                                                   | text null                | đuôi log kỹ thuật, **tối đa 64 KB**, đã redact (không có token/mật khẩu) |
| `requested_by` | text FK user (set null) | `user.id` của Better Auth là text |
| `created_at`, `started_at`, `finished_at`, `updated_at` | timestamptz              |                                                                          |

- **Unique index một phần**: chỉ 1 dòng `status IN ('pending','running')` tại một thời điểm.
- `updater` nhận việc: `UPDATE ... SET status='running', started_at=now() WHERE id=(SELECT id ... WHERE status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.
- Cột `target_version` có CHECK regex chặt (migration `0003`); `updater` vẫn phải tự kiểm tra lại `^\d+\.\d+\.\d+$` trước khi ghép tên image.
- `updater` coi dòng `running` quá 30 phút là bị treo → đánh `failed`. Khi updater **khởi động**, mọi dòng `running` còn sót (không thể là của tiến trình này) bị đánh `failed` ngay (không đợi 30 phút) để UI không kẹt.
- **Dòng `pending` quá cũ**: updater chỉ nhận dòng `pending` có `created_at` trong 10 phút gần nhất; dòng `pending` cũ hơn 10 phút bị đánh `failed` (message tiếng Việt, kèm activity log `system.update_failed` với `reason: "stale_pending"`) để updater bật lại sau nhiều ngày không tự chạy một cú bấm cũ, và để không chặn unique index một phần.
- **Kiểu `requested_by`**: `user.id` của Better Auth là **text** (không phải uuid), nên cột phải là `text` (FK `user(id)` `ON DELETE SET NULL`). Updater luôn đọc bằng `requested_by::text` nên chấp nhận cả hai, nhưng migration của app nên dùng `text` để FK hợp lệ.
- **`step` do updater ghi**: `backup` → `pull` → `migrate` → `restart` (ghi `APP_VERSION` + `up -d`) → `healthcheck`; thành công kết thúc ở `healthcheck`; sau khi rollback (kể cả rollback lỗi) là `rollback`; lỗi trước bước `backup` (kiểm tra đầu vào) thì `step` = null. `status` cuối: `succeeded`; `failed` (chưa đụng bản chạy, hoặc rollback cũng lỗi); `rolled_back` (bản mới lỗi sau khi đã thay, đã quay về).
- **Metadata `activity_logs`** do updater ghi: `{ from, to, durationMs, failedStep?, backupFile?, rollback? ("ok"|"failed"), reason? }`; `target_type` = `system_update`, `target_id` = id yêu cầu, `target_label` = `"<from> -> <to>"`, `actor_role` = vai trò của người bấm (hoặc `system` nếu `requested_by` đã bị xoá), `status` = `success`/`failure`. Ghi trong savepoint cùng transaction với việc đổi `status`: lỗi ghi log (vd thiếu partition) không làm mất trạng thái cuối.
- **Heartbeat** chỉ được ghi khi updater tự kiểm tra ổn (thấy `docker.sock`, `docker-compose.yml` và `.env` của thư mục dự án). Updater cấu hình sai thì không có heartbeat → UI hiện "chưa bật".

**`app_settings`** (JSON; khoá nội bộ, không sửa qua form Cài đặt):

- `update_latest` = `{ version, tag, publishedAt, notes (≤4000 ký tự, text thuần), url, checkedAt }` hoặc không có.
- `update_check_error` = `{ at, message }` (lỗi lần kiểm tra gần nhất, đã redact).
- `updater_heartbeat` = `{ at, version, composeProject }` — `updater` ghi mỗi 30 s. UI chỉ bật nút Cập nhật khi heartbeat < 90 s; ngược lại hiện "Cập nhật tự động chưa bật" + lệnh chạy tay.

**Phiên bản đang chạy**: `APP_BUILD_VERSION` (ENV bake lúc build từ tag, khác với biến compose `APP_VERSION` dùng để chọn tag image); fallback `package.json#version`; bản dev/main hiển thị `dev`.

**Activity log mới** (thêm vào danh mục ở 03-database-schema.md §4): `system.update_check`, `system.update_requested`, `system.update_succeeded`, `system.update_failed`, `system.update_rolled_back`. Hai action cuối/đầu do `updater` ghi trực tiếp trong cùng transaction với việc đổi trạng thái (actor = `requested_by`).

**Hạ tầng (đã làm, chi tiết ở `07-deployment.md` §6)**: service `updater` (profile `updater`, bật bằng `COMPOSE_PROFILES=updater` trong `.env`), image `ghcr.io/notivn/ads-mcp-simple-updater:<ver>`, thư mục dự án mount đúng đường dẫn host (`HOST_PROJECT_DIR`). Web/worker nhận thêm `.env`: `UPDATE_REPO` (mặc định `notivn/Ads-MCP-simple`) và `UPDATE_GITHUB_TOKEN` (tuỳ chọn) - đã đặt sẵn dạng comment trong `.env.example`, **app tự đọc và dùng mặc định khi thiếu**. `APP_VERSION` trong `.env` do updater ghi; app chỉ đọc `APP_BUILD_VERSION`.
Điều kiện để updater hoạt động: image được phát hành từ workflow `docker.yml` (có ENV `APP_BUILD_VERSION` đúng tag - updater từ chối image có `APP_BUILD_VERSION` khác tag - và có chữ ký cosign của chính workflow đó cho đúng tag). Updater cần ra Internet tới ghcr.io và Sigstore; `TUF_ROOT=/tmp/sigstore-tuf`.

## 4. Giao diện

- **Menu người dùng** (sidebar footer trên máy tính, tab "Menu" trên di động): dòng `Phiên bản v1.2.0`. Admin + có bản mới: chấm cảnh báo trên avatar/nút Menu + mục "Có bản mới v1.3.0".
- **Khối "Phiên bản" ở sidebar** (máy tính, ngay trên nút tài khoản, ẩn khi sidebar thu về icon - `SidebarVersion` trong `components/app/app-version.tsx`, 2026-10-08): mọi người thấy "Hiện tại vX"; admin thấy thêm "Mới nhất vY" (`VersionBadge.latestKnown` = bản mới nhất đã biết từ GitHub, kể cả khi không mới hơn; "Chưa kiểm tra" khi chưa có), huy hiệu "Có bản mới" / "Đã cập nhật", cả khối là link tới `/settings/updates`. Nhân viên: khối chỉ là chữ, không link (`latestKnown` luôn null).
- **Trang `/settings/updates`** (chỉ admin; link từ Cài đặt + menu): phiên bản hiện tại, phiên bản mới nhất, ghi chú phát hành (escape, không render HTML), **tự kiểm tra GitHub ngay khi mở trang** (1 lần mỗi lần vào trang, client gọi `checkUpdatesAction({ auto: true })`; thẻ Phiên bản hiện "Đang kiểm tra…", không toast; bị giới hạn tần suất hay lỗi thì im lặng, lỗi đã lưu hiện trong thẻ; nhật ký `system.update_check` có `metadata.trigger = "auto" | "manual"`), "Kiểm tra ngay" (kiểm tra lại), "Cập nhật lên vX" (nút `brand` duy nhất; dialog xác nhận nêu: gián đoạn ~1-2 phút, đã tự sao lưu; re-auth), tiến trình theo bước (poll), lịch sử 10 lần gần nhất, trạng thái updater.
- **Tổng quan**: admin có bản mới → thêm 1 cảnh báo vào khung "Cảnh báo".
- Nhân viên: chỉ thấy số phiên bản; route/action/API cập nhật trả 404/forbidden.
- Có `PageGuide` riêng cho trang cập nhật (xem guides.ts); toàn bộ chuỗi trong `src/lib/i18n/vi/`.

## 5. Phát hành (GitHub Actions)

- Tag `v*` → `docker.yml`: build-arg `APP_BUILD_VERSION`, đẩy `ghcr.io/notivn/ads-mcp-simple:<ver>` + `...-updater:<ver>` (SBOM + provenance, không tag `latest`), ký cosign keyless cả 2 digest; tạo GitHub Release (ghi chú `release-notes/<tag>.md`) khi tag khớp `^v\d+\.\d+\.\d+$` (tag có hậu tố `-rc` chỉ build, không tạo Release).
- Kiểm tra `package.json#version` khớp tag, tag nằm trên nhánh mặc định, bản stable chưa có Release (fail sớm nếu lệch). Image phát hành **chỉ** do CI đẩy (image đẩy tay không có chữ ký, updater từ chối).
- Quy trình phát hành ghi ở `07-deployment.md` (checklist: test xanh → bump version → tag → push tag → xem Release → admin bấm Cập nhật).
