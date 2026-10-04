# Phát hành thêm nền tảng quảng cáo (Google Ads, TikTok Ads)

> Bản hiện tại hỗ trợ **Meta** và **OpenAI Ads**. **Google Ads** và **TikTok Ads** là nền tảng _sắp ra mắt_: chỉ hiện thẻ mờ "Sắp ra mắt" ở `/connections/new` (bấm vào → popup "Kết nối … chưa sẵn sàng"); **không có mã nguồn adapter, tool MCP, hướng dẫn token hay biến môi trường nào của hai nền tảng này trong repo và Docker image**. Mỗi nền tảng sẽ được phát hành ở một phiên bản cập nhật riêng để thu hút người dùng nâng cấp (cơ chế cập nhật 1 chạm: `10-update-system.md`).
>
> Mã nguồn adapter + tài liệu API của hai nền tảng được phát triển **ngoài repo chính** (chủ dự án giữ). Khi phát hành, đưa vào repo theo checklist dưới đây.

## 1. Một chỗ cấu hình duy nhất

`src/lib/platforms.ts`:

| Hằng số              | Ý nghĩa                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALL_PLATFORMS`      | Khớp enum Postgres `platform` (`meta`, `tiktok`, `google_ads`, `openai_ads`) - **không bao giờ bớt** (migration/dữ liệu phụ thuộc)                                                                                                              |
| `RELEASED_PLATFORMS` | Nền tảng có adapter trong bản build. Mọi danh sách runtime đều suy ra từ đây: kết nối (`CONNECTION_PLATFORMS`), MCP (`MCP_PLATFORMS`), nhật ký (`LOG_PLATFORMS`), biểu đồ (`CHART_PLATFORMS`), `PLATFORMS` của provider (grant, extension, job) |
| `UPCOMING_PLATFORMS` | Chỉ để vẽ thẻ "Sắp ra mắt" ở `/connections/new`                                                                                                                                                                                                 |

Kết nối cũ của nền tảng không nằm trong `RELEASED_PLATFORMS` (nếu DB còn) được **ẩn và bỏ qua**: không liệt kê, không mở được chi tiết, job không kiểm tra, grant MCP không nạp (`services/connections.ts`, `services/ad-accounts.ts`, `services/dashboard.ts`, `jobs/lib/connection-ops.ts`, `mcp/grant.ts`). Dữ liệu vẫn giữ nguyên trong DB → khi phát hành nền tảng, chúng hiện lại.

## 2. Checklist phát hành một nền tảng (ví dụ Google Ads)

1. **Adapter**: thêm `src/server/providers/<platform>/` (implement `AdsProvider`, không import `next/*`), đăng ký trong `src/server/providers/index.ts` (`allProviders`).
2. **Cấu hình**: chuyển nền tảng từ `UPCOMING_PLATFORMS` sang `RELEASED_PLATFORMS` trong `src/lib/platforms.ts`.
3. **Kiểu theo nền tảng** (TypeScript sẽ báo lỗi chỗ thiếu khi bước 2 xong): `McpFormValues.platforms` + `defaultMcpFormValues()` (`src/lib/schemas/mcp-servers.ts`), `ChartPoint` + khởi tạo `byDay` (`services/dashboard.ts`), `SERIES`/`chartConfig` (`_overview/calls-chart.tsx`, thêm token `--chart-platform-*` trong `globals.css`), regex lỗi trường `platforms.(…)` (`mcp-wizard.tsx`), `PREFIX` tên tool (`mcp/tools/extensions.ts`), `PLATFORM_LABEL` (`mcp/grant.ts`), `accountIdCandidates` nếu id có nhiều cách viết.
4. **Biến môi trường** version API (`src/server/env.ts`, `.env.example`, bảng "Phiên bản API" ở `settings/page.tsx` + ghi chú trong `i18n/vi/settings.ts`).
5. **Chuỗi giao diện**: gợi ý trạng thái kết nối (`i18n/vi/connection-status.ts` - `hint.invalid/expiring`), hướng dẫn chọn nền tảng (`i18n/vi/guides.ts`), `platformDesc` (`i18n/vi/connections.ts`), mô tả metadata (`app/layout.tsx`), từ khoá tìm kiếm (`components/app/nav.ts`).
6. **Tính năng riêng**: luồng đổi mã uỷ quyền (OAuth/auth code) nếu nền tảng cần (service + action + schema + UI wizard/thay token), lệnh CLI lấy refresh token, cấp `keyword` (chỉ thêm lại vào `objectLevelSchema`/`reportLevelSchema` khi nền tảng có từ khoá), loại tra cứu riêng (`LOOKUP_KINDS`).
7. **Tool MCP**: cập nhật mô tả tool chung (`mcp/tools/common/*`, `mcp/schemas.ts`, `mcp/instructions.ts`) cho đúng nền tảng mới (định dạng account_id, đơn vị tiền, thời điểm có hiệu lực…).
8. **Tài liệu**: `providers/<platform>.md` (chạy `/provider-api-check <platform>` trước), `04-mcp-design.md` (danh mục tool), hướng dẫn lấy token cho người dùng `docs/huong-dan-lay-token-<platform>.md`, `docs/ket-noi-ai.md`, `CLAUDE.md`, `.claude/rules/providers.md`, skill `provider-api-check`, agent `ads-api-reviewer`.
9. **Test**: unit test adapter (fixture JSON thật đã ẩn danh), `World.create()` tự đăng ký fake cho mọi nền tảng released; thêm `demoAccounts` cho nền tảng (`mcp/__tests__/flows/world.ts`), test luồng kết nối thật nếu có OAuth.
10. **Phát hành**: tăng phiên bản (minor, ví dụ `1.1.0`), viết `release-notes/v1.1.0.md` (nêu rõ nền tảng mới + token cần chuẩn bị), build + smoke test image local, push tag → GitHub Actions build image + tạo Release. Admin thấy bản mới trong **Cài đặt → Cập nhật hệ thống**.

## 3. Gỡ một nền tảng (nếu cần tạm ẩn)

Làm ngược checklist: chuyển về `UPCOMING_PLATFORMS`, xoá adapter khỏi `allProviders`/repo, sửa các chỗ TypeScript báo lỗi, gỡ chuỗi/tài liệu/biến môi trường. Dữ liệu trong DB được giữ và tự ẩn.
