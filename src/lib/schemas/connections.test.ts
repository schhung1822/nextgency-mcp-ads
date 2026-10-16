import { describe, expect, it } from "vitest"

import { connectionStatus as cs } from "@/lib/i18n/vi/connection-status"

import {
  ACTION_REQUIRED_TTL_MS,
  actionRequiredDtoOf,
  readActionRequired,
  CONNECTION_PLATFORMS,
  createConnectionSchema,
  defaultOffSummary,
  enabledDiffFromDefaults,
  initialEnabledExternalIds,
  isDefaultEnabled,
  splitTrailingHint,
  statusHintFor,
  statusTooltip,
  visibleStatusHint,
  type AdAccountStatusValue,
} from "./connections"

describe("isDefaultEnabled", () => {
  it("switches closed / disabled / pending and manager accounts OFF by default", () => {
    expect(isDefaultEnabled({ status: "active" })).toBe(true)
    expect(isDefaultEnabled({ status: "unknown" })).toBe(true)
    for (const status of ["closed", "disabled", "pending"]) expect(isDefaultEnabled({ status })).toBe(false)
    expect(isDefaultEnabled({ status: "active", isManager: true })).toBe(false)
    expect(isDefaultEnabled({ status: "active", isManager: false })).toBe(true)
  })
})

describe("statusHintFor", () => {
  it("gives a platform specific next step for invalid and expiring tokens", () => {
    const hints = new Set<string>()
    for (const platform of CONNECTION_PLATFORMS) {
      const invalid = statusHintFor({ platform, status: "invalid", statusMessage: "x" })
      const expiring = statusHintFor({ platform, status: "expiring", statusMessage: "x" })
      expect(invalid).toMatch(/Thay token/)
      expect(expiring).toMatch(/trước khi hết hạn/)
      hints.add(invalid!)
    }
    expect(hints.size).toBe(CONNECTION_PLATFORMS.length)
  })

  it("tells the admin what to do when the stored token cannot be decrypted (status unchanged)", () => {
    const hint = statusHintFor({ platform: "meta", status: "active", statusMessage: "Không giải mã được token đã lưu." })
    expect(hint).toMatch(/ENCRYPTION_KEYS/)
  })

  it("suggests a retry for a transient failure on an active connection and nothing for a healthy one", () => {
    expect(statusHintFor({ platform: "meta", status: "active", statusMessage: "Không kiểm tra được: lỗi" })).toMatch(/Kiểm tra lại/)
    expect(statusHintFor({ platform: "meta", status: "active", statusMessage: null })).toBeNull()
    expect(statusHintFor({ platform: "meta", status: "disabled", statusMessage: null })).toBeNull()
  })
})

describe("createConnectionSchema", () => {
  it("accepts the optional ON / OFF lists and defaults them to empty", () => {
    const base = { platform: "meta", name: "BM", credentials: { access_token: "x".repeat(30) } }
    const a = createConnectionSchema.parse(base)
    expect(a.disabledExternalIds).toEqual([])
    expect(a.enabledExternalIds).toEqual([])
    const b = createConnectionSchema.parse({ ...base, disabledExternalIds: ["a"], enabledExternalIds: ["b"] })
    expect(b.enabledExternalIds).toEqual(["b"])
  })
})

// ---------------------------------------------------------------------------
// Wizard step 3: switches start from `defaultEnabled`, only the differences are sent
// ---------------------------------------------------------------------------
type Acc = { externalId: string; defaultEnabled: boolean; isManager: boolean; status: AdAccountStatusValue }
const acc = (externalId: string, status: AdAccountStatusValue, isManager = false): Acc => ({
  externalId,
  status,
  isManager,
  defaultEnabled: isDefaultEnabled({ status, isManager }),
})
const MIXED: Acc[] = [
  acc("a-active", "active"),
  acc("a-unknown", "unknown"),
  acc("a-closed", "closed"),
  acc("a-disabled", "disabled"),
  acc("a-pending", "pending"),
  acc("a-mcc", "active", true),
]

/** what `upsertAdAccounts` does on initial creation (connection-ops.ts) */
function serverEnabled(accounts: Acc[], send: { disabledExternalIds: string[]; enabledExternalIds: string[] }) {
  const disabled = new Set(send.disabledExternalIds)
  const forcedOn = new Set(send.enabledExternalIds)
  return new Set(
    accounts
      .filter((a) => !disabled.has(a.externalId) && (forcedOn.has(a.externalId) || isDefaultEnabled(a)))
      .map((a) => a.externalId)
  )
}

describe("wizard step 3 switches", () => {
  it("starts from each account's default (closed / disabled / pending / MCC OFF, active / unknown ON)", () => {
    expect([...initialEnabledExternalIds(MIXED)].sort()).toEqual(["a-active", "a-unknown"])
  })

  it("sends nothing when the user keeps the defaults", () => {
    expect(enabledDiffFromDefaults(MIXED, initialEnabledExternalIds(MIXED))).toEqual({
      disabledExternalIds: [],
      enabledExternalIds: [],
    })
  })

  it("sends default-on accounts switched off as `disabled` and default-off ones switched on as `enabled`", () => {
    const on = initialEnabledExternalIds(MIXED)
    on.delete("a-active")
    on.add("a-closed")
    on.add("a-mcc")
    expect(enabledDiffFromDefaults(MIXED, on)).toEqual({
      disabledExternalIds: ["a-active"],
      enabledExternalIds: ["a-closed", "a-mcc"],
    })
  })

  it("'Bật tất cả' enables the four default-off accounts; 'Tắt tất cả' disables the two default-on ones", () => {
    expect(enabledDiffFromDefaults(MIXED, new Set(MIXED.map((a) => a.externalId)))).toEqual({
      disabledExternalIds: [],
      enabledExternalIds: ["a-closed", "a-disabled", "a-pending", "a-mcc"],
    })
    expect(enabledDiffFromDefaults(MIXED, new Set())).toEqual({
      disabledExternalIds: ["a-active", "a-unknown"],
      enabledExternalIds: [],
    })
  })

  it("every switch combination ends exactly as shown once the server applies its rules", () => {
    for (let mask = 0; mask < 1 << MIXED.length; mask++) {
      const shown = new Set(MIXED.filter((_, i) => mask & (1 << i)).map((a) => a.externalId))
      const send = enabledDiffFromDefaults(MIXED, shown)
      // the lists must also pass the request schema
      const parsed = createConnectionSchema.parse({
        platform: "meta",
        name: "BM",
        credentials: { access_token: "x".repeat(30) },
        ...send,
      })
      expect(serverEnabled(MIXED, parsed)).toEqual(shown)
    }
  })

  it("counts what starts OFF by reason (a closed MCC counts as manager)", () => {
    expect(defaultOffSummary(MIXED)).toEqual({ inactive: 3, manager: 1, total: 4 })
    expect(defaultOffSummary([acc("x", "active")])).toEqual({ inactive: 0, manager: 0, total: 0 })
    expect(defaultOffSummary([acc("m", "closed", true)])).toEqual({ inactive: 0, manager: 1, total: 1 })
  })
})

// ---------------------------------------------------------------------------
// statusMessage + statusHint
// ---------------------------------------------------------------------------
describe("visibleStatusHint", () => {
  const hint = 'Tạo API key mới trong OpenAI Ads, rồi bấm "Thay token" ở trang kết nối.'

  it("shows the hint when the message does not say it", () => {
    expect(visibleStatusHint("Token không hợp lệ hoặc đã bị thu hồi.", hint)).toBe(hint)
    expect(visibleStatusHint(null, hint)).toBe(hint)
    expect(visibleStatusHint("", hint)).toBe(hint)
  })

  it("shows nothing without a hint", () => {
    expect(visibleStatusHint("Token không hợp lệ.", null)).toBeNull()
    expect(visibleStatusHint("Token không hợp lệ.", undefined)).toBeNull()
    expect(visibleStatusHint("Token không hợp lệ.", "   ")).toBeNull()
  })

  it("drops a hint the message already contains (case, spacing and the final full stop do not matter)", () => {
    expect(visibleStatusHint(`API key bị từ chối (401). ${hint}`, hint)).toBeNull()
    expect(visibleStatusHint(`API key bị từ chối.  ${hint.toUpperCase().replace(/\.$/, "")}`, hint)).toBeNull()
  })

  it("keeps only the sentences of the hint the message does not contain", () => {
    const first = "Thử lại sau ít phút."
    expect(visibleStatusHint(`Nền tảng đang bận. ${first}`, `${first} Nếu vẫn lỗi, liên hệ quản trị viên.`)).toBe(
      "Nếu vẫn lỗi, liên hệ quản trị viên."
    )
  })

  it("does not swallow a hint that merely shares words with the message", () => {
    // adapter sentence "Hãy tạo token mới và cập nhật kết nối." is not the platform hint
    const msg = "Kết nối Meta không còn hợp lệ: Token mất hiệu lực do đổi mật khẩu. Hãy tạo token mới và cập nhật kết nối."
    expect(visibleStatusHint(msg, cs.hint.invalid.meta)).toBe(cs.hint.invalid.meta)
  })
})

describe("splitTrailingHint", () => {
  it("splits the server's '<message> <hint>' strings", () => {
    expect(splitTrailingHint(`Token không hợp lệ hoặc đã bị thu hồi. ${cs.hint.pasteAgain}`)).toEqual({
      message: "Token không hợp lệ hoặc đã bị thu hồi.",
      hint: cs.hint.pasteAgain,
    })
    for (const platform of CONNECTION_PLATFORMS) {
      const hint = cs.hint.invalid[platform]
      expect(splitTrailingHint(`Token không hợp lệ. ${hint}`)).toEqual({ message: "Token không hợp lệ.", hint })
    }
  })

  it("leaves any other text alone", () => {
    expect(splitTrailingHint("Mật khẩu không đúng.")).toEqual({ message: "Mật khẩu không đúng.", hint: null })
    // a hint on its own is the whole text, not "message + hint"
    expect(splitTrailingHint(cs.hint.pasteAgain)).toEqual({ message: cs.hint.pasteAgain, hint: null })
    // must follow whitespace: no cutting a word in half
    expect(splitTrailingHint(`x${cs.hint.pasteAgain}`).hint).toBeNull()
  })
})

describe("statusTooltip", () => {
  it("joins what happened and the next step on two lines, once", () => {
    expect(statusTooltip({ statusMessage: "Token đã hết hạn.", statusHint: "Thay token." })).toBe("Token đã hết hạn.\nThay token.")
    expect(statusTooltip({ statusMessage: "Token đã hết hạn. Thay token.", statusHint: "Thay token." })).toBe(
      "Token đã hết hạn. Thay token."
    )
    expect(statusTooltip({ statusMessage: null, statusHint: "Thay token." })).toBe("Thay token.")
    expect(statusTooltip({ statusMessage: null, statusHint: null })).toBeUndefined()
  })
})

describe("readActionRequired / actionRequiredDtoOf (D6)", () => {
  const now = Date.parse("2026-10-16T10:00:00Z")
  const flag = {
    since: "2026-10-15T10:00:00.000Z",
    lastAt: "2026-10-16T09:00:00.000Z",
    platform: "meta",
    accountExternalId: "act_1",
    accounts: ["act_1", 2, "", "act_2"],
    message: "Hãy xác thực",
  }
  it("parses a stored flag (drops non-string accounts)", () => {
    expect(readActionRequired(flag, now)).toEqual({ ...flag, accounts: ["act_1", "act_2"] })
    expect(actionRequiredDtoOf({ actionRequired: flag, other: 1 }, now)).toEqual({
      since: flag.since,
      lastAt: flag.lastAt,
      accounts: ["act_1", "act_2"],
      message: "Hãy xác thực",
    })
  })
  it("absent, malformed or older than 7 days (from the last failure) → null", () => {
    expect(actionRequiredDtoOf({}, now)).toBeNull()
    expect(actionRequiredDtoOf(null, now)).toBeNull()
    expect(readActionRequired("yes", now)).toBeNull()
    expect(readActionRequired([flag], now)).toBeNull()
    expect(readActionRequired({ since: "not a date" }, now)).toBeNull()
    expect(readActionRequired(flag, Date.parse(flag.lastAt) + ACTION_REQUIRED_TTL_MS + 1)).toBeNull()
    expect(readActionRequired(flag, Date.parse(flag.lastAt) + ACTION_REQUIRED_TTL_MS)).not.toBeNull()
  })
})
