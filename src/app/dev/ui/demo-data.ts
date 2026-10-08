// Sample data for the /dev/ui component gallery (dev only - never imported by real pages).
import type { ConnectionStatus, LogStatus } from "@/components/app/status"
import type { ConnectionGuide, Platform } from "@/server/providers/types"

export interface DemoConnection {
  id: string
  name: string
  platform: Platform
  owner: string
  accounts: number
  status: ConnectionStatus
  tokenExpiresAt: string | null
  checkedAt: string
}

const now = Date.now()
const minutes = (n: number) => new Date(now - n * 60_000).toISOString()
const daysAhead = (n: number) => new Date(now + n * 86_400_000).toISOString()

export const DEMO_CONNECTIONS: DemoConnection[] = [
  {
    id: "c1",
    name: "BM chính",
    platform: "meta",
    owner: "Thắng",
    accounts: 12,
    status: "active",
    tokenExpiresAt: null,
    checkedAt: minutes(5),
  },
  {
    id: "c2",
    name: "Via Shop VN",
    platform: "meta",
    owner: "Lan",
    accounts: 3,
    status: "expiring",
    tokenExpiresAt: daysAhead(5),
    checkedAt: minutes(62),
  },
  {
    id: "c3",
    name: "OpenAI Ads agency",
    platform: "openai_ads",
    owner: "Thắng",
    accounts: 8,
    status: "invalid",
    tokenExpiresAt: null,
    checkedAt: minutes(180),
  },
  {
    id: "c4",
    name: "OpenAI Ads thử nghiệm",
    platform: "openai_ads",
    owner: "Minh",
    accounts: 1,
    status: "active",
    tokenExpiresAt: daysAhead(60),
    checkedAt: minutes(15),
  },
  {
    id: "c5",
    name: "BM phụ (khách hàng A)",
    platform: "meta",
    owner: "Lan",
    accounts: 4,
    status: "disabled",
    tokenExpiresAt: null,
    checkedAt: minutes(60 * 30),
  },
  {
    id: "c6",
    name: "BM agency",
    platform: "meta",
    owner: "Minh",
    accounts: 6,
    status: "active",
    tokenExpiresAt: daysAhead(300),
    checkedAt: minutes(2),
  },
  {
    id: "c7",
    name: "TikTok Shop VN",
    platform: "tiktok",
    owner: "Lan",
    accounts: 3,
    status: "active",
    tokenExpiresAt: null,
    checkedAt: minutes(9),
  },
  {
    id: "c8",
    name: "Google MCC tổng (gồm YouTube)",
    platform: "google_ads",
    owner: "Thắng",
    accounts: 5,
    status: "invalid",
    tokenExpiresAt: null,
    checkedAt: minutes(95),
  },
]

export interface DemoLog {
  id: string
  at: string
  mcp: string
  client: string
  tool: string
  platform: Platform
  status: LogStatus
  durationMs: number
}

const TOOLS = [
  "ads_get_report",
  "ads_list_campaigns",
  "ads_set_status",
  "ads_update_budget",
  "meta_create_campaign",
  "ads_copy_object",
]
const CLIENTS = ["Claude", "ChatGPT", "Gemini", "Claude Code"]
const STATUSES: LogStatus[] = [
  "success",
  "success",
  "success",
  "error",
  "denied",
  "rate_limited",
  "pending_confirmation",
  "invalid_request",
]
const PLATFORMS: Platform[] = ["meta", "tiktok", "google_ads", "openai_ads"]

/** Deterministic fake keyset page (newest first). */
export function demoLogPage(
  cursor: number,
  size = 8
): { rows: DemoLog[]; nextCursor: number | null } {
  const total = 30
  const rows: DemoLog[] = []
  for (let i = cursor; i < Math.min(cursor + size, total); i++) {
    rows.push({
      id: `log-${i}`,
      at: minutes(i * 7 + 1),
      mcp:
        i % 3 === 0
          ? "Báo cáo hằng ngày"
          : i % 3 === 1
            ? "Vận hành Meta"
            : "Agency OpenAI",
      client: CLIENTS[i % CLIENTS.length],
      tool: TOOLS[i % TOOLS.length],
      platform: PLATFORMS[i % PLATFORMS.length],
      status: STATUSES[i % STATUSES.length],
      durationMs: 120 + ((i * 337) % 2400),
    })
  }
  const next = cursor + size
  return { rows, nextCursor: next < total ? next : null }
}

export const DEMO_GUIDE: ConnectionGuide = {
  summary: "Dùng System User trong Business Manager để có token không hết hạn.",
  steps: [
    {
      title: "Mở Cài đặt doanh nghiệp",
      detail: "Vào Business Settings → Người dùng → Người dùng hệ thống.",
      link: {
        label: "Mở Business Settings",
        url: "https://business.facebook.com/settings/system-users",
      },
    },
    {
      title: "Tạo System User (Quản trị viên)",
      detail:
        "Bấm Thêm, đặt tên dễ nhớ (vd: ads-mcp), chọn vai trò Quản trị viên.",
    },
    {
      title: "Gán tài sản",
      detail:
        "Chọn Thêm tài sản → Tài khoản quảng cáo → tick các TKQC cần quản lý với quyền Quản lý chiến dịch.",
    },
    {
      title: "Tạo token",
      detail:
        "Bấm Tạo token mới, chọn app của bạn, thời hạn: Không bao giờ, tick các quyền bên dưới rồi sao chép token.",
      link: {
        label: "Xem tài liệu Meta",
        url: "https://developers.facebook.com/docs/marketing-api/system-users",
      },
    },
  ],
  requiredScopes: ["ads_management", "ads_read", "business_management"],
  warnings: [
    "Token chỉ hiện một lần - dán ngay vào ô bên trái.",
    "Không chia sẻ token qua chat hay email.",
  ],
}

export const DEMO_JSON = {
  tool: "ads_update_budget",
  arguments: {
    account_id: "act_1234567890",
    level: "campaign",
    id: "120210000000001",
    daily_budget: { amount: 1500000, currency: "VND" },
  },
  before: { daily_budget: 1000000, status: "ACTIVE" },
  after: { daily_budget: 1500000, status: "ACTIVE" },
  platform_request_id: "AbCdEf123456",
  warnings: [],
  note: "<script>alert('xss')</script> được hiển thị như văn bản thường",
  dry_run: false,
  duration_ms: 842,
  nested: { level1: { level2: { level3: [1, 2, 3, null, true] } } },
}

export const DEMO_SPARK = [820, 932, 901, 1034, 990, 1130, 1284]
export const DEMO_ERROR_SPARK = [0.8, 1.1, 0.9, 1.4, 1.0, 1.3, 1.2]
