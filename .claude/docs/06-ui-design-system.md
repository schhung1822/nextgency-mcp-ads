# Design system & UI

Mục tiêu: **nhìn là hiểu, bấm là làm được** — bố cục kiểu **Shopify admin (Polaris)**, chất liệu **Liquid Glass** (Apple 2025) cho phần "khung", màu chủ đạo **gradient đỏ → cam** từ logo noti.vn, font **Inter**, có **Sáng/Tối**, toàn bộ tiếng Việt. Mọi component dựng trên **shadcn/ui** (style `radix-maia`) — không tự viết lại component đã có trong shadcn.

## 1. Thương hiệu
- Tên: **Ads MCP by: noti.vn** (tiêu đề trang: `Ads MCP · noti.vn`; `<title>` từng trang: `<Tên trang> · Ads MCP`).
- Logo (thư mục `logo/`, copy tối ưu sang `public/brand/`):
  - `logo-duong-ban.png` (chữ đen) → nền sáng; `logo-am-ban.png` (chữ trắng) → nền tối. Bản gốc ~3577x1056 (tỉ lệ ~3,39:1) đã resize còn **480x142** vào `public/brand/logo-duong-ban.png` và `logo-am-ban.png` (>= 3x cho mọi kích thước hiển thị, ~14KB/file; tạo lại bằng `sharp` từ `logo/`, không thêm dependency). `<BrandLogo height>` render 2 `<Image>` + class `dark:hidden` / `hidden dark:block` (CSS thuần theo class `dark` của next-themes nên không nháy lúc tải); width tính theo tỉ lệ ảnh, không méo.
  - `favicon.png` (ô vuông đỏ chữ N) → favicon tab trình duyệt, **icon rail của sidebar thu gọn** (`BrandMark`), avatar mặc định của MCP. Favicon/`metadata.icons` giữ nguyên.
  - **Header dùng logo đầy đủ ở mọi cỡ**: sidebar mở (cao 30px, ẩn bằng `group-data-[collapsible=icon]:hidden`; khi sidebar thu về icon rail 768-1279px thì đổi sang `BrandMark` vuông 32px, không nhét logo dài vào rail), top bar điện thoại < md (cao 26px, vì không có sidebar), màn đăng nhập/setup/2FA/đổi mật khẩu (`AuthCard`, cao 36px) và `StatusScreen` (30px). Link logo có `aria-label="Ads MCP"`; alt của ảnh là "noti.vn". Chữ "Ads MCP" + "by noti.vn" không còn đi kèm logo ở sidebar (`BrandWordmark` vẫn có trong thư viện).
- Màu lấy mẫu từ logo: đỏ **#ED3C47**, chữ **#1A1B1B**.

## 2. Token màu (Tailwind v4, `src/app/globals.css`)
| Token | Sáng | Tối | Dùng cho |
|---|---|---|---|
| `--brand-red` | `#ED3C47` oklch(0.627 0.212 22.8) | như sáng | logo, accent, focus ring, chart-1 |
| `--brand-orange` | `#F26A1B` oklch(0.682 0.186 44.8) | như sáng | accent, chart-2, wordmark gradient |
| `--primary-from` → `--primary-to` | `#D6303C` → `#CC4A0E` | như sáng | **nút chính** (đạt AA 4.5:1 với chữ trắng) |
| `--primary` | `var(--primary-from)` | | shadcn primary |
| `--destructive` | rose-600 | rose-500 | xoá/nguy hiểm — khác sắc độ với brand để không nhầm |
| success / warning / info | emerald-600 / amber-500 / sky-600 | sáng hơn 1 bậc | badge trạng thái |
| `--background` | trắng ấm `oklch(0.985 0.004 30)` | `oklch(0.16 0.01 30)` | nền |
⚠️ `#ED3C47` với chữ trắng chỉ đạt 3.93:1 → **không** dùng làm nền nút có chữ; gradient nút chính dùng cặp `#D6303C → #CC4A0E`. Gradient `#ED3C47 → #F26A1B` chỉ cho logo/wordmark/viền/biểu đồ.

Màu nền tảng (chỉ dùng trong icon/badge nhỏ): Meta `#0866FF`, OpenAI `#000`/trắng ở dark; Google Ads logo 3 màu `#FBBC04`/`#4285F4`/`#34A853`, TikTok `#000`/trắng ở dark (+ `#FE2C55` điểm nhấn), YouTube (dấu nhỏ ở góc logo trên thẻ "Google Ads (gồm YouTube)") `#FF0000`, Telegram `#26A5E4`, Google Drive 3 màu (path simple-icons tách 3 phần: trái `#34A853`, phải `#FBBC04`, đáy `#4285F4` - `<BrandIcon brand="drive">`, dùng ở tab Google Drive, thẻ "Kho creative", khối Email hệ thống, wizard, khối Google Drive của MCP). Icon thương hiệu là SVG inline (simple-icons, CC0) trong `components/app/platform-icon.tsx`.

## 3. Liquid Glass — quy tắc
- **Glass chỉ cho "khung" nổi trên nội dung**: top bar, sidebar (floating), menu/popover/dropdown, dialog/sheet, thanh hành động hàng loạt nổi, thanh "Có thay đổi chưa lưu", toast, thẻ KPI ở Tổng quan, màn hình đăng nhập.
- **Nội dung dày đặc dùng card đặc** (`Card` shadcn): bảng, form, JSON log. **Không glass chồng glass.**
- Hiệu năng: blur ≤ 24px, **không animate** backdrop-filter, không đặt glass lên hàng bảng/danh sách/vùng cuộn lớn. Tổ tiên có `filter`/`opacity<1`/`mask` sẽ làm glass bên trong "không thấy" nền.
- Khúc xạ SVG (`backdrop-filter: url(#filter)`) **chỉ Chromium** → không dùng ở v1 (tuỳ chọn sau cho 1 phần tử nhỏ cố định).
- Trợ năng: tôn trọng `prefers-reduced-transparency` (Safari chưa hỗ trợ) + toggle trong app **"Giảm hiệu ứng trong suốt"** (`html[data-transparency="reduced"]`, lưu localStorage) + `prefers-contrast: more` + `forced-colors` → về nền đặc.

```css
:root {
  --brand-red: oklch(0.627 0.212 22.8);  --brand-orange: oklch(0.682 0.186 44.8);
  --primary-from: oklch(0.576 0.201 22.9); --primary-to: oklch(0.581 0.176 40.0);
  --primary: var(--primary-from); --primary-foreground: oklch(0.985 0 0);
  --ring: var(--brand-red); --chart-1: var(--brand-red); --chart-2: var(--brand-orange);
  --radius: 0.75rem;
  --glass-tint: oklch(1 0 0 / 0.62); --glass-tint-strong: oklch(1 0 0 / 0.8);
  --glass-edge: oklch(1 0 0 / 0.75); --glass-specular: oklch(1 0 0 / 0.95); --glass-shade: oklch(0.25 0.02 30 / 0.06);
  --glass-drop: 0 1px 1px oklch(0.2 0.02 30 / 0.04), 0 10px 30px -10px oklch(0.2 0.02 30 / 0.18);
  --glass-blur: 18px; --glass-sat: 1.8; --sidebar: var(--glass-tint);
}
.dark {
  --glass-tint: oklch(0.22 0.01 30 / 0.55); --glass-tint-strong: oklch(0.22 0.01 30 / 0.75);
  --glass-edge: oklch(1 0 0 / 0.12); --glass-specular: oklch(1 0 0 / 0.18); --glass-shade: oklch(0 0 0 / 0.35);
  --glass-drop: 0 1px 1px oklch(0 0 0 / 0.3), 0 16px 40px -12px oklch(0 0 0 / 0.7); --sidebar: var(--glass-tint);
}
@theme inline {
  --color-brand-red: var(--brand-red); --color-brand-orange: var(--brand-orange);
  --color-primary-from: var(--primary-from); --color-primary-to: var(--primary-to);
}
@layer base {
  body::before { /* nền ấm để glass có gì đó phía sau */
    content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background:
      radial-gradient(1100px 520px at 0% -10%, color-mix(in oklab, var(--brand-red) 16%, transparent), transparent 65%),
      radial-gradient(900px 480px at 100% 0%, color-mix(in oklab, var(--brand-orange) 14%, transparent), transparent 60%),
      var(--background);
  }
}
@utility glass {
  position: relative; background-color: var(--glass-tint);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  border: 1px solid var(--glass-edge);
  box-shadow: inset 0 1px 0 0 var(--glass-specular), inset 0 -1px 0 0 var(--glass-shade), var(--glass-drop);
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { background-color: var(--card); }
  @media (prefers-reduced-transparency: reduce) { background-color: var(--card); backdrop-filter: none; -webkit-backdrop-filter: none; }
  :root[data-transparency="reduced"] & { background-color: var(--card); backdrop-filter: none; -webkit-backdrop-filter: none; }
  @media (prefers-contrast: more), (forced-colors: active) { background-color: var(--card); border-color: var(--border); box-shadow: none; backdrop-filter: none; }
}
@utility glass-strong { @apply glass; background-color: var(--glass-tint-strong); }
[data-slot="sidebar-inner"] {  /* <Sidebar variant="floating" collapsible="icon"> */
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  box-shadow: inset 0 1px 0 var(--glass-specular), var(--glass-drop);
  border-radius: calc(var(--radius) * 1.6);
}
:root[data-transparency="reduced"], :root[data-transparency="reduced"].dark { --sidebar: var(--card); }
```
(Nested `@media/@supports/&` trong `@utility` cần kiểm tra khi build; nếu lỗi → viết CSS thường cho `.glass`.)

Nút chính — thêm variant `brand` vào `components/ui/button.tsx` (cva), dùng cho **1 hành động chính mỗi trang**:
```ts
brand: "text-white bg-linear-135 from-primary-from to-primary-to " +
  "shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_-1px_0_rgb(0_0_0/0.15),0_1px_2px_rgb(0_0_0/0.15),0_8px_20px_-6px_color-mix(in_oklab,var(--brand-red)_55%,transparent)] " +
  "hover:brightness-[1.06] active:translate-y-px active:brightness-95 disabled:opacity-60 disabled:saturate-50 " +
  "focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_oklab,var(--brand-red)_45%,transparent)] " +
  "dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_0_0_1px_rgb(255_255_255/0.06),0_10px_28px_-6px_color-mix(in_oklab,var(--brand-red)_65%,transparent)]",
```
Wordmark gradient: `bg-linear-135 from-brand-red to-brand-orange bg-clip-text text-transparent`.

## 4. Typography & spacing
- Inter (`next/font/google`, `subsets: ['latin','vietnamese']`, biến `--font-sans`), `<html lang="vi">`. Số liệu trong bảng dùng `tabular-nums`. ID/key dùng `font-mono` cỡ nhỏ.
- Cỡ chữ: tiêu đề trang 24/32 semibold · tiêu đề card 16/24 semibold · nội dung 14/20 · phụ 13/18 `text-muted-foreground`.
- Khoảng cách theo thang 4px; card padding 20px (`p-5`); khoảng cách giữa card 16–20px; nội dung trang `max-w-[1200px]` (trang log/bảng rộng: `max-w-[1600px]`).
- Bo góc: card `rounded-2xl`, input/nút `rounded-xl`, badge `rounded-full`.

## 5. Bố cục (Polaris → shadcn)
| Mẫu Polaris | Cách làm |
|---|---|
| Frame: top bar + nav trái | block `sidebar-16` (header dính), `Sidebar variant="floating" collapsible="icon"`; top bar `glass sticky top-0 z-40`: logo, ô tìm kiếm ⌘K (`Command` — nhảy tới trang/MCP/kết nối), chuông cảnh báo token, menu người dùng (Tài khoản, Giao diện Sáng/Tối/Hệ thống, Giảm trong suốt, Đăng xuất) |
| Page header | Breadcrumb/nút quay lại · tiêu đề + 1 câu mô tả · **1 nút chính `brand` góc phải** · hành động phụ trong dropdown "Thêm" |
| Layout section | Card đặc 1 cột hoặc 2 cột (chính 2/3 + phụ 1/3) |
| IndexTable + IndexFilters | `Tabs` làm "view" (Tất cả / Đang hoạt động / Lỗi…), ô tìm kiếm, filter pill (`Popover` + `Badge`), `Select` sắp xếp; chọn nhiều dòng → **thanh hành động nổi glass** ở đáy; phân trang keyset; click dòng → `Sheet` chi tiết |
| Empty state | component `empty`: minh hoạ, 1 câu giải thích, nút chính |
| Toast | `sonner` `position="bottom-center" richColors` |
| Contextual save bar | thanh glass dính đỉnh "Có thay đổi chưa lưu" — Huỷ / Lưu |
| Wizard | Stepper ngang (số bước + tên), nút Quay lại / Tiếp tục ở chân, lưu nháp trong state |

Responsive: ≥1024 sidebar mở; 768–1023 sidebar thu icon; <768 sidebar thành `Sheet`, bảng chuyển dạng card list.

## 6. Component dùng chung (`src/components/app/`)
`AppShell`, `PageHeader`, `GlassCard`, `KpiCard`, `DataTable` (TanStack v9, chế độ server-side cho log), `FilterBar`, `DateRangePicker` (preset Hôm nay/Hôm qua/7 ngày/30 ngày/Tháng này/Tháng trước/Tuỳ chọn), `PlatformIcon`, `PlatformBadge`, `StatusBadge` (map trạng thái → màu + nhãn tiếng Việt), `PermissionBadges`, `CopyField` (ô readonly + nút sao chép + toast "Đã sao chép"), `SecretInput` (ẩn/hiện, không bao giờ prefill), `ConfirmDialog` (gõ tên để xác nhận với hành động xoá), `JsonViewer` (thu gọn/mở rộng, escape an toàn), `Stepper`, `HelpPanel` (hướng dẫn lấy token từng bước, có ảnh/link), `ThemeToggle`, `TransparencyToggle`, `EmptyState`, `RelativeTime`.

## 7. Wireframe các trang chính
### Tổng quan `/`
```
[Tổng quan]  Theo dõi nhanh kết nối, MCP và lượt gọi từ AI.          [+ Tạo MCP]
┌ glass KPI ┐ ┌ glass KPI ┐ ┌ glass KPI ┐ ┌ glass KPI ┐ ┌ glass KPI ┐
│Kết nối  6 │ │TKQC    24 │ │MCP hoạt 5 │ │Lượt gọi   │ │Tỉ lệ lỗi  │
│2 cảnh báo │ │           │ │           │ │24h  1.284 │ │  1,2%     │
┌ Lượt gọi MCP 7/30 ngày (area chart, màu theo nền tảng) ─────────┐ ┌ Cảnh báo ─────────────┐
│                                                                  │ │⚠ Token Meta "BM chính"│
│                                                                  │ │  hết hạn sau 5 ngày   │
└──────────────────────────────────────────────────────────────────┘ │✖ OpenAI "Shop" lỗi xác│
┌ Hoạt động gần đây (MCP + nhân sự, 10 dòng, link "Xem tất cả") ───┐ │  thực — Kiểm tra lại  │
```
### Kết nối `/connections` (tên menu cũ: Kết nối quảng cáo)
```
[Kết nối]  Dán token từ app developer của bạn để kết nối tài khoản QC.  [+ Thêm kết nối]
Tabs (3, không cuộn ngang): [🔌 Quảng cáo 25] · [Telegram 3] · [Google Drive 7]   (icon ẩn < sm; ?tab=all|telegram|drive)
Tab Quảng cáo: [Tìm kiếm...] [+ Nền tảng ▾ (Meta · TikTok · Google Ads · OpenAI Ads, đếm từng nền tảng, chọn nhiều)] [+ Trạng thái ▾]
  (link cũ ?platform=meta / ?platform=youtube → chọn sẵn bộ lọc Nền tảng; lọc đúng 1 nền tảng chưa có kết nối → Empty "Chưa có kết nối X" + [Thêm kết nối X])
Mô tả PageHeader đổi theo tab: Quảng cáo "Dán token từ app developer…" · Telegram "Thêm bot Telegram để nhận cảnh báo…" · Google Drive "Khai báo thư mục ảnh, video hoặc Google Sheet kế hoạch để AI lấy file lên quảng cáo."
| Tên            | Nền tảng | Người tạo* | TKQC | Trạng thái        | Hạn token  | Kiểm tra lúc |
| BM chính       | (f) Meta | Thắng      | 12   | ● Hoạt động       | Không hạn  | 5 phút trước |
| OpenAI Shop    | (◎)      | Lan        | 1    | ● Sắp hết hạn     | 07/10/2026 | 1 giờ trước  |
(* cột Người tạo chỉ hiện với Admin)    Empty: "Chưa có kết nối nào — Thêm kết nối đầu tiên để bắt đầu."
```
### Google Drive (`/connections?tab=drive`, `/connections/drive/new`, `/connections/drive/[id]` — 2026-10-09, `15-google-drive-media.md` §11/§18)
Chuỗi: `src/lib/i18n/vi/drive-ui.ts` (+ panel Hướng dẫn `driveUi.guides`). Theo khuôn trang Telegram; nút chính `brand` "Thêm thư mục / sheet".
```
Tab Google Drive:
┌ Email hệ thống (đầu Card danh sách) ──────────────────────────────────────────────┐
│ ads-mcp@project.iam.gserviceaccount.com [Sao chép]  (admin) Đọc link Drive công khai: đã bật │
│ Chia sẻ thư mục (Người xem) hoặc sheet (Người chỉnh sửa nếu muốn ghi trạng thái)…  │
└────────────────────────────────────────────────────────────────────────────────────┘
  (chưa cấu hình → Alert: admin "Mở Cài đặt" / nhân viên "liên hệ quản trị viên"; credential lỗi → Alert đỏ)
| Tên            | Loại        | Phạm vi | Người tạo* | Trạng thái  | Kiểm tra lần cuối | MCP        |
| Creative T10   | Thư mục     | Công ty | Thắng      | ● Hoạt động | 5 phút trước      | 3 MCP      |
| Kế hoạch QC    | Google Sheet| Riêng   | Lan        | ● Lỗi       | 1 giờ trước       | Chưa gán MCP|
Khối "Service account riêng" [Nâng cao]: danh sách + Thêm (Dialog dán JSON) / Kiểm tra / Xoá
```
- Bảng: tên xuống tối đa 2 dòng (`line-clamp-2`), cột "Kiểm tra lần cuối" chỉ hiện từ @4xl; lỗi trạng thái 2 dòng. Email hệ thống dùng `CopyField wrap` (xuống dòng trên điện thoại, không bị cắt). Nhân viên xem nguồn đọc bằng email hệ thống: gợi ý sửa chỉ dành cho admin (tạo khoá JSON, bật API…) được thay bằng "Báo quản trị viên kiểm tra Cài đặt → Google Drive hệ thống" (`driveStatusText`, chỉ ở UI).
- **Thêm** `/connections/drive/new` (Stepper 3 bước, panel Hướng dẫn theo bước `driveUi.guides.newSteps[step]` - bước 2 có danh sách lỗi thường gặp; lỗi định dạng link nằm dưới ô link, lỗi quyền / service account / Google là Alert đỏ): ① Loại (thẻ Thư mục | Google Sheet) + Phạm vi (Công ty — chỉ admin | Riêng của tôi) → ② "Chia sẻ cho email nào?" (Email hệ thống — khuyên dùng | Service account riêng) + CopyField email + các bước chia sẻ + ô link (sheet: link có `#gid=`) + nút **Kiểm tra** → kết quả (tên trên Drive, "12 ảnh · 3 video · 2 thư mục con", Shared drive; sheet: tab, số dòng, dòng tiêu đề, quyền của email) → ③ Tên hiển thị, số cấp thư mục con (Select 0–3); sheet: dòng tiêu đề + **ánh xạ cột** (Cột AI đọc: Link Drive (bắt buộc), Tên creative, Nền tảng, Tài khoản QC, Nội dung, Tiêu đề, Link đích → Switch "Cho phép AI ghi trạng thái vào sheet" (tắt kèm gợi ý khi email chỉ là Người xem) → Collapsible "Cột ghi trạng thái (nâng cao)": Trạng thái (bắt buộc khi bật ghi), Mã media, Mã quảng cáo, Link bài viết, Link chiến dịch, Ghi chú hệ thống, Cập nhật lúc - đúng thứ tự mẫu sheet, mọi cột tuỳ chọn có dòng trợ giúp "Tuỳ chọn. …" - tự mở và khoá mở khi bật ghi trạng thái) → [Lưu thư mục / sheet]. Sửa thông tin sau khi Kiểm tra → "bấm Kiểm tra lại".
- **Chi tiết** `/connections/drive/[id]`: PageHeader (Kiểm tra lại · Sửa cài đặt (Dialog) · Xoá (ConfirmDialog liệt kê MCP bị ảnh hưởng)); Card Thông tin + "Đang dùng trong MCP"; thư mục: lưới file **Card đặc** (ảnh thu nhỏ từ `/api/drive/thumb/…`, tên, dung lượng, badge "Đã dùng ở N TKQC"), lọc Tất cả / Ảnh / Video, breadcrumb thư mục con, "Tải thêm", dòng "N file khác được bỏ qua"; sheet: bảng 20 dòng đầu theo ánh xạ cột + badge thống kê trạng thái. Info "Ánh xạ cột" chia 2 nhóm "AI đọc" / "AI ghi" (tắt ghi trạng thái → nhóm "AI ghi (đang tắt)" mờ đi; sheet chưa ánh xạ Link bài viết / Link chiến dịch → dòng "Chưa dùng: …" + nút `outline` "Sửa cài đặt" mở Dialog sửa, chỉ người quản lý). Chip trạng thái sheet có màu (Chờ lên vàng · Đang xử lý xanh dương · Đã lên xanh lá · Lỗi đỏ · "Chưa có trạng thái" trung tính). Lỗi Google khi đọc danh sách → Alert + ghi chú "Trạng thái ở đầu trang là kết quả của lần kiểm tra trước (…)" + **một** nút: người quản lý "Kiểm tra lại" (kiểm tra nguồn + tải lại danh sách, giống nút ở PageHeader), người chỉ xem "Tải lại". `/connections/drive` chuyển về `?tab=drive`.
- **Cài đặt → Google Drive hệ thống** (admin): Card đặc — trạng thái (Hoạt động / Lỗi / Chưa cấu hình), email + Sao chép, project, mã khoá, API key (`…abcd` hoặc "Chưa có - link công khai tắt"), kiểm tra lần cuối, số nguồn đang dùng; SecretInput nhiều dòng cho service account JSON (write-only, trống = giữ), SecretInput API key (chỉ hiện hint) + Checkbox "Xoá API key"; nút Kiểm tra / Lưu thông tin xác thực (`outline`, thành `brand` khi đã nhập gì đó - trang Cài đặt không có nút brand ở header) / Xoá (Lưu, Xoá mở hộp xác thực lại). Thẻ rộng (container ≥ 56rem, `@4xl`): form bên trái (7fr) + khung **"Hướng dẫn cấu hình"** bên phải (5fr, `settings/_components/drive-settings-help.tsx`, chuỗi `src/lib/i18n/vi/drive-settings-help.ts`, Accordion 4 mục: dùng để làm gì · lấy khoá JSON (Bắt buộc) · API key link công khai (Không bắt buộc) · sau khi lưu); thẻ hẹp / điện thoại: 1 cột, khung hướng dẫn nằm dưới form - **riêng khi chưa cấu hình** thì khung hướng dẫn lên trước form (`order-first`, mở sẵn mục khoá JSON) để quản trị viên đọc cách lấy JSON trước khi thấy ô trống. Bước "Google Drive hệ thống" đã rời khỏi panel Hướng dẫn của trang (`guides.settings`). Đây là **ngoại lệ được chủ dự án duyệt (2026-10-10)** cho quy tắc "không dựng aside hướng dẫn trong trang" ở §11.
- **Khối Google Drive trong MCP** (`mcp-servers/_components/drive-sections.tsx`, wizard + tab Cấu hình + Tổng quan): bước ② tiêu đề nhóm "Ảnh, video quảng cáo (không bắt buộc)" → Card "Google Drive" với Checkbox nguồn theo nhóm Của công ty / Của tôi / Của nhân viên (admin), badge loại + trạng thái, nguồn lỗi/tắt có cảnh báo, trống → EmptyState + "Thêm thư mục / sheet"; bước ② nguồn "Đang tắt" không chọn mới được (Checkbox vô hiệu, vẫn bỏ chọn được nếu đã chọn); bước ③ Card "Google Drive": Switch "Cho phép dùng link Drive công khai" (mặc định bật - mô tả hiển thị nổi bằng `font-medium text-warning-strong`; vô hiệu + gợi ý khi chưa có API key) và "Cho phép ghi trạng thái vào Google Sheet" (mặc định bật) + ghi chú cần quyền Tạo mới (đã chọn nguồn Drive mà không nền tảng nào có Tạo mới → Alert vàng nhẹ); Tổng quan: 3 dòng tóm tắt (Google Drive · Link Drive công khai · Ghi trạng thái vào Google Sheet).

### Thêm kết nối `/connections/new` (wizard 3 bước)
```
① Chọn nền tảng  ② Nhập thông tin  ③ Kiểm tra & chọn tài khoản
Bước 1: lưới 2 cột thẻ lớn có logo + mô tả 1 dòng — nhóm "Quảng cáo": Meta · TikTok Ads · Google Ads (gồm YouTube) (một thẻ duy nhất: logo Google Ads + dấu YouTube nhỏ ở góc, mô tả thêm câu "Quảng cáo YouTube (chiến dịch Video, Demand Gen) cũng chạy qua kết nối này."; form luôn kèm Alert "YouTube Ads chạy qua Google Ads" và khung Hướng dẫn có phần YouTube; link cũ `?platform=youtube` vẫn mở form này) · OpenAI Ads; nhóm "Kênh thông báo": Telegram (→ `/connections/telegram/new`); nhóm "Kho creative" ("Khai báo thư mục hoặc Google Sheet để AI lấy ảnh, video lên quảng cáo."): Google Drive (→ `/connections/drive/new`). Thẻ "Sắp ra mắt" (nét đứt, mờ, popup "chưa sẵn sàng") chỉ hiện khi `UPCOMING_PLATFORMS` khác rỗng.
        TikTok bước 2 có SegmentedControl "Dán access token | Đổi auth_code"; Google Ads có chọn kiểu xác thực "Service account (khuyên dùng) | OAuth refresh token"
Bước 2: ┌ Form (Card đặc) ─────────────┐ ┌ Panel Hướng dẫn: "Cách lấy token Meta" ─┐
        │Tên kết nối*                  │ │1. Vào Business Settings → ...      │
        │Access token*  [••••••] 👁    │ │2. Tạo System User ...  [Mở trang ↗]│
        │App ID / App secret (tuỳ chọn)│ │Quyền cần tick: ads_management...   │
Bước 3: spinner "Đang kiểm tra..." → ✔ Token hợp lệ (hạn, scope) → bảng TKQC tìm thấy có checkbox bật/tắt → [Lưu kết nối]
        ✖ lỗi → thông điệp tiếng Việt + gợi ý sửa (map từ mã lỗi nền tảng)
```
### Tạo MCP `/mcp-servers/new` (wizard 4 bước — đúng thứ tự yêu cầu)
```
① Tên  ② Nền tảng & tài khoản  ③ Quyền  ④ Bảo vệ
② Mỗi nền tảng 1 card có công tắc bật; bật → chọn kết nối (multi) → "Tất cả tài khoản" hoặc chọn từng TKQC; dưới cùng khối Telegram và khối Google Drive (chọn thư mục / sheet)
③ Mỗi nền tảng đã bật 1 hàng checkbox: [✔ Xem (luôn bật)] [ ] Bật/Tắt [ ] Sửa [ ] Sao chép [ ] Tạo mới [ ] Xoá/Lưu trữ ⚠
   Nút nhanh: "Chỉ xem" · "Vận hành (xem + bật/tắt + sửa)" · "Toàn quyền (trừ xoá)"
④ Xác nhận 2 bước [bật] · Giới hạn đổi ngân sách mỗi lần [50]% · Trần ngân sách/ngày (theo tiền tệ) · Hết hạn [không] · Giới hạn lệnh/phút [60] · IP cho phép
→ Màn hình hoàn tất (glass card):
   ✔ Đã tạo MCP "Báo cáo hằng ngày"
   Link MCP: [https://ads.example.com/mcp/amcp_xxxx…  ] [Sao chép]
   ⚠ Ai có link này đều dùng được MCP. Không chia sẻ công khai.
   Tabs hướng dẫn: Claude · ChatGPT · Gemini · Claude Code · Gemini CLI (từng bước + lệnh copy được)
```
### MCP `/mcp-servers` và `/mcp-servers/[id]`
Danh sách: Tên · Người tạo (Admin) · Nền tảng (icon) · Quyền (badge) · Trạng thái · Lần dùng cuối · Lượt gọi 7 ngày (sparkline).
Chi tiết: tabs **Tổng quan** (KPI + biểu đồ) · **Cấu hình** (sửa bước 2–4, contextual save bar) · **Kết nối AI** (link + hướng dẫn; "Xem lại link" yêu cầu nhập mật khẩu/OTP) · **Nhật ký** · **Bảo mật** (Xoay key, Tắt/Bật, Xoá — `ConfirmDialog`).
### Nhật ký `/logs`
```
[Nhật ký]  Mọi hoạt động của MCP và nhân sự được lưu {N} tháng.          [Xuất CSV]
Tabs: [Nhật ký MCP] [Nhật ký nhân sự (Admin)]
FilterBar: Khoảng thời gian (bắt buộc, mặc định 24h) · MCP · Người tạo · Nền tảng · Tool · Trạng thái · ☐ Chỉ thao tác ghi
| Thời gian ↓ | MCP | Client | Tool | Nền tảng/TKQC | Trạng thái | Thời lượng |
Click dòng → Sheet phải: tóm tắt + bảng "Trước → Sau" + JsonViewer (request/response) + request id nền tảng
```
### Người dùng `/users` (Admin)
Bảng: Tên · Email · Vai trò · 2FA · Trạng thái · Đăng nhập cuối. Nút chính "Thêm người dùng" (Dialog: tên, email, vai trò, mật khẩu tạm — có nút sinh ngẫu nhiên + sao chép). Hành động dòng: Đổi vai trò · Đặt lại mật khẩu · Đặt lại 2FA · Khoá/Mở khoá · Xem phiên · Xoá.
### Cài đặt `/settings` (Admin)
Card: Lưu trữ nhật ký (số tháng MCP / nhân sự, 1–24) · Bảo mật (bắt buộc 2FA cho mọi người, thời lượng phiên) · Mặc định khi tạo MCP · Phiên bản API nền tảng (chỉ đọc + cảnh báo khi sắp hết hạn) · **Google Drive hệ thống** (xem mục Google Drive ở trên) · Thông tin hệ thống (version app, dung lượng log).
### Đăng nhập `/login`, `/login/2fa`, `/setup`
Nền gradient ấm + 1 glass card giữa màn: logo, "Đăng nhập Ads MCP", email, mật khẩu, nút `brand` "Đăng nhập". 2FA: `InputOTP` 6 ô (tự submit khi đủ), link "Dùng mã dự phòng". Không có link "Đăng ký".

## 8. Văn phong tiếng Việt
- Xưng "bạn"; câu ngắn; nút bắt đầu bằng động từ: "Thêm kết nối", "Tạo MCP", "Sao chép link", "Kiểm tra lại", "Lưu thay đổi".
- Thuật ngữ thống nhất: Connection = **Kết nối** · Ad account = **Tài khoản quảng cáo (TKQC)** · Campaign = **Chiến dịch** · Ad set / Ad group = **Nhóm quảng cáo** · Ad = **Quảng cáo** · Spend = **Chi tiêu** · Impressions = **Lượt hiển thị** · Reach = **Người tiếp cận** · Clicks = **Lượt nhấp** · Conversions = **Chuyển đổi** · Budget = **Ngân sách** · Staff = **Nhân viên** · Activity log = **Nhật ký nhân sự** · MCP log = **Nhật ký MCP** · Telegram notification channel = **Kết nối Telegram** (không gọi "kênh"; chữ "Kênh" chỉ dành cho loại chat Telegram - `ui.chatTypes.channel` - và nhóm "Kênh thông báo" ở bước 1 Thêm kết nối) · Telegram topic / `message_thread_id` = **Chủ đề (Thread ID)** (nhãn ô nhập/thông tin; tiêu đề cột bảng: "Chủ đề").
- Định dạng: tiền `Intl.NumberFormat('vi-VN', {style:'currency', currency})` (vd `1.250.000 ₫`, `12,50 US$`); số `1.284`; ngày `dd/MM/yyyy HH:mm` theo `Asia/Ho_Chi_Minh`; thời gian tương đối `date-fns` locale `vi` ("5 phút trước").
- Thông báo lỗi: nói chuyện gì xảy ra + cách sửa ("Token Meta đã hết hạn. Vào Business Settings tạo token mới rồi dán lại."). Không hiện stack trace.
- Tất cả chuỗi UI đặt trong `src/lib/i18n/vi.ts` (object typed) — chuẩn bị cho đa ngôn ngữ sau này; zod dùng `z.config(z.locales.vi())`.

## 9. Trợ năng & chất lượng
- Tương phản AA (chữ thường 4.5:1) ở cả 2 theme; focus ring luôn thấy được (`--ring` đỏ thương hiệu).
- Mọi thao tác dùng được bằng bàn phím; dialog bẫy focus; icon-only button có `aria-label` tiếng Việt.
- `prefers-reduced-motion` → tắt animation trang trí.
- Kiểm tra giao diện bằng Chrome DevTools MCP (screenshot sáng/tối, mobile 390px, desktop 1440px) trước khi báo xong một trang.

## 10. Quy ước bổ sung từ đợt rà soát UI (2026-10-02)
- **Khung**: sidebar nổi, top bar và nội dung cách mép 8px; nội dung thụt vào so với mép top bar 0 (điện thoại) / 16px (tablet) / 24px (desktop). `<header>` nằm ngoài `<main id="main-content">`, có link "Bỏ qua điều hướng". `viewport-fit=cover` + padding `env(safe-area-inset-*)`.
- **PageHeader**: tiêu đề cách nội dung 24px (`pb-6` của PageHeader; trang **không** thêm `gap-6` giữa header và nội dung). Điện thoại: nút `brand` chiếm trọn 1 hàng.
- **Card**: padding 20px, tiêu đề semibold 16/24 (`role="heading" aria-level=2`); khoảng cách giữa các card 16px (điện thoại) / 24px (≥sm).
- **Bảng**: `DataTable` dùng container query — dưới 768px *bề rộng bảng* chuyển sang danh sách card (`renderMobileCard`); cột phụ ẩn theo `meta.hideBelow` (không để bảng cuộn ngang); bảng dài ở md+ cuộn trong card với `stickyHeader`.
- **FilterBar** trên điện thoại: các filter pill thành 1 hàng vuốt ngang. Popover/menu luôn cách mép màn hình ≥ 12px (menu 8px).
- **Contextual save bar** đặt ở đầu cột nội dung (ngay dưới PageHeader) để hiện ngay khi form bị sửa rồi dính dưới top bar; trang có save bar **không** thêm nút lưu `brand` ở PageHeader (chỉ 1 nút `brand`).
- **Chạm**: điều khiển trên top bar, filter pill, nút trong thanh hành động ≥ 40px khi `pointer: coarse` hoặc ≤ md (`pointer-coarse:`).
- **Kiểm thử giao diện**: `node scripts/ui-shots.mjs --cookies <cookies.json> --out <dir> --routes "/,/logs#detail" --viewports laptop,desktop,tablet,mobile --themes light,dark` (chụp + báo console, tràn ngang, mục tiêu chạm nhỏ, control không tên).

## 11. Panel Hướng dẫn, thanh điều hướng dưới và giao diện tràn màn hình (2026-10-03)
- **Panel Hướng dẫn (bên phải)**: mọi trang/bước wizard có hướng dẫn riêng, mount bằng `<PageGuide guide={t.guides.xxx} />` (nội dung ở `src/lib/i18n/vi/guides.ts`, kiểu `GuideDef` ở `src/lib/guide-types.ts`: `title`, `summary`, `steps[{title,detail,link}]`, `tips`, `warnings`, `requiredScopes`, `links`). `PageGuide` không render gì, chỉ đăng ký nội dung vào `GuideProvider` của `AppShell`; `guide` phải ổn định giữa các lần render (hằng số hoặc `useMemo`). Wizard truyền guide theo bước (`tg.mcpNew.steps[step]`, kết nối: `connectionNew.platform` → guide của provider → `connectionNew.verify`); trang có tab truyền guide theo tab đang chọn. Guide của provider = `{ title, ...spec.guide }` + `platform` để hiện icon nền tảng. **Không** tự dựng aside hướng dẫn trong trang (đã bỏ `GuideLayout`); `HelpPanel` chỉ còn là card inline (thư viện giao diện). Ngoại lệ duy nhất (chủ dự án duyệt 2026-10-10): khung "Hướng dẫn cấu hình" bên trong thẻ **Cài đặt → Google Drive hệ thống** (xem mục Google Drive ở §7) - nội dung cấu hình dài, chỉ admin đọc, gắn liền với form.
- **Máy tính (≥ lg, 1024px)**: panel dính bên phải (320px, 360px từ 2xl), card đặc (không glass), cuộn riêng, **luôn mở mặc định ở mọi trang/bước/tab**. Nút "Thu gọn" chỉ có tác dụng tạm thời (không lưu): `html[data-guide-collapsed]` ẩn panel, top bar hiện nút "Hướng dẫn" để mở lại; chuyển trang/bước/tab thì panel tự mở lại. Từ 768–1279px sidebar tự thu về icon để nhường chỗ cho panel. Khi chuyển trang, hướng dẫn cũ giữ 1,5 giây để panel không nháy lúc `loading.tsx` hiện.
- **Tablet/điện thoại (< lg)**: panel ẩn; top bar có nút **icon sách + chữ "Hướng dẫn"** (cao 40px) chỉ khi trang có guide → mở `Sheet` **từ dưới lên, cao 80% màn hình** (bo góc trên, thanh kéo, nền đặc), đóng khi đổi trang hoặc khi màn hình rộng ≥ lg.
- **Điện thoại (< md, 768px) tràn màn hình**: không còn sidebar/hamburger, top bar phẳng sát mép (hairline dưới, gần như đặc), nội dung lề 16px; **card cấp cao nhất tràn hai mép** (vuông, `margin-inline: -16px`, rule trong `globals.css`; card lồng card hoặc nằm trong `<button>` được xử lý riêng), chữ/bộ lọc/nút giữ lề 16px. Thanh lưu thay đổi và thanh hành động wizard cũng phẳng, sát mép.
- **Thanh điều hướng dưới (< md)**: `BottomNav` cố định, 60px + `env(safe-area-inset-bottom)`, 5 tab: Tổng quan · Kết nối · MCP · Nhật ký · Menu (`BOTTOM_NAV_ITEMS` trong `nav.ts`). Tab đang mở: nền pill brand + chữ đậm `brand-ink` + `aria-current`. Menu mở bottom sheet: Người dùng/Cài đặt (chỉ admin), Tài khoản, Sáng/Tối/Hệ thống, Giảm trong suốt, Đăng xuất. Thanh tự ẩn khi bàn phím ảo mở (`html[data-kb-open]`). Mọi thứ dính đáy phải dùng biến `--app-bottom-offset` (= cao thanh + safe area, bằng 0 từ md và khi bàn phím mở), ví dụ `sticky bottom-(--app-bottom-offset,0px)`; `<main>` đã có `padding-bottom` tương ứng; toast (`mobileOffset`) và thanh thao tác hàng loạt của `DataTable` đã tính sẵn.
- **Dialog / AlertDialog / Sheet trên điện thoại (< sm)**: dialog là bottom sheet toàn chiều rộng (bo góc trên, `max-h` có cuộn, padding safe-area); sheet phải/trái rộng 100%. Từ sm trở lên giữ modal giữa màn hình. Popover/Select vẫn neo vào trigger (lề ≥ 12px).
- **Màn hình đăng nhập/bảo mật trên điện thoại (< sm)**: không còn thẻ glass giữa nền gradient; cả màn hình là một mặt phẳng đặc, logo ở trên, field full-width, trang cuộn khi bàn phím mở. Từ sm giữ thẻ glass ở giữa.
- **Tìm nhanh (`CommandPalette`)**: từ lg (1024px) là dialog giữa màn hình (bo 20px, rộng tối đa `max-w-xl`). **Dưới lg** (điện thoại + tablet) là **bottom sheet cao 80dvh** giống `GuideSheet`: `SheetContent side="bottom"`, `rounded-t-3xl`, thanh kéo, nền đặc `bg-popover`. Ô nhập cao 48px ở đầu sheet (chữ 16px để iOS không tự phóng to) + nút "Đóng"; danh sách kết quả cuộn riêng (`overscroll-contain`, đệm `safe-area-inset-bottom`), mỗi mục cao >= 48px. Khi bàn phím ảo mở, hook `useKeyboardAwareSheetStyle` (đọc `visualViewport`) nâng sheet lên trên bàn phím và giới hạn chiều cao theo vùng nhìn thấy để ô nhập và kết quả không bị che. ⌘K / Ctrl+K mở ở mọi cỡ; nút tìm trên top bar điện thoại có `aria-label` + `title` "Mở tìm kiếm nhanh". Chuyển giữa dialog và sheet theo `matchMedia` nên xoay/đổi cỡ cửa sổ vẫn giữ trạng thái mở.
- **Kiểm thử**: `ui-shots.mjs` có thêm scene `search`, `search-type`, `guide-collapse`, `guide-sheet`, `menu`, `bottom` và tự báo phần tử bị thanh dưới che trên điện thoại; chạy với `MSYS_NO_PATHCONV=1` trong Git Bash để route `/` không bị đổi thành đường dẫn Windows.

## 12. Trang chính sách công khai (2026-10-05)
- `/privacy`, `/terms`, `/data-deletion` nằm trong route group `src/app/(legal)/` (layout riêng, **không** dashboard chrome, không cần phiên): top bar glass mỏng (logo + `ThemeToggle`), dải tab 3 trang (`LegalNav`, `aria-current`), nội dung trong **một `Card` đặc** rộng tối đa `max-w-3xl` (chữ 15px/leading-7, h1 → h2 mục → phần English `lang="en"` h2 + h3), footer liên kết + "Ads MCP by: noti.vn". Điện thoại: card tràn mép như trang quản trị (`#main-content`). Mọi chữ ở `src/lib/i18n/vi/legal.ts`; tên đơn vị/email chỉ render dạng text React, email thành `mailto:` khi hợp lệ.
- Khối **"Liên kết cho ứng dụng"** (`components/app/legal-links.tsx`): `SidebarFooter`, dưới menu người dùng, 3 dòng `SidebarMenuButton size="sm"` (mở tab mới) + `SidebarMenuAction` sao chép (tooltip, toast "Đã sao chép liên kết", URL tuyệt đối từ `BETTER_AUTH_URL`, dự phòng `window.location.origin`); ẩn khi sidebar thu về icon rail. Điện thoại: cùng 3 dòng trong sheet Menu (dòng 48px + nút sao chép 48px). ⌘K có nhóm "Trang chính sách".

## 13. Nút báo lỗi / yêu cầu tính năng và khối Phiên bản ở sidebar (2026-10-08)
- **Nút nổi "Báo bug, yêu cầu tính năng"** (`components/app/feedback-button.tsx`, gắn một lần trong `AppShell` - mọi trang dashboard, mọi vai trò): `<a target="_blank" rel="noopener noreferrer">` tới form noti.vn (`FEEDBACK_FORM_URL` trong `src/lib/feedback.ts`), `glass-strong` bo tròn, icon `Bug01Icon` màu `brand-ink`. Máy tính (≥ md): viên thuốc icon + chữ, cách mép phải 24px, đáy 20px (+ safe area). Điện thoại: chỉ icon, tròn 48px, cách mép phải 16px, nằm trên thanh điều hướng dưới (`--app-bottom-offset`). Không phải nút `brand` (mỗi trang chỉ 1 nút brand). Tự nâng lên `--feedback-lift` (4.25rem, `globals.css`) khi trang có thanh hành động dính đáy - đánh dấu thanh đó bằng `data-bottom-action-bar` (thanh nút wizard Thêm kết nối, thanh thao tác hàng loạt của `DataTable`); ẩn khi bàn phím ảo mở và khi in. Panel Hướng dẫn (lg+) dừng cách đáy 4.75rem để nút không che nội dung.
- **Khối "Phiên bản"** (`SidebarVersion`, `SidebarFooter` ngay trên nút tài khoản, ẩn trên icon rail): khung viền mảnh trong sidebar (không glass lồng glass), 2 dòng "Hiện tại / Mới nhất" `tabular-nums`, huy hiệu "Có bản mới" (nền `brand-red/12`, chữ `brand-ink`, khung viền đỏ nhạt) hoặc "Đã cập nhật" (success). Admin: cả khối là link tới `/settings/updates` (`aria-label` đọc cả hai phiên bản); nhân viên: chỉ "Hiện tại", không link. Điện thoại giữ nguyên sheet Menu (dòng "Phiên bản vX" + "Có bản mới vY").
