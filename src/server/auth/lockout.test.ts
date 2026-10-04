import { describe, expect, it } from "vitest"

import {
  isLocked,
  isSignInLocked,
  lockoutIpKey,
  LOCKOUT_DURATION_MS,
  LOCKOUT_EMAIL_MAX_FAILURES,
  LOCKOUT_MAX_FAILURES,
  LOCKOUT_WINDOW_MS,
  lockoutKey,
  nextStateAfterFailure,
  normalizeEmail,
  parseState,
  stateExpiry,
  type LockoutState,
} from "./lockout"

const T0 = 1_800_000_000_000

function failN(n: number, start = T0, stepMs = 1000): LockoutState | null {
  let s: LockoutState | null = null
  for (let i = 0; i < n; i++) s = nextStateAfterFailure(s, start + i * stepMs)
  return s
}

describe("lockout theo email", () => {
  it("9 lần sai chưa khoá, lần thứ 10 khoá 15 phút", () => {
    const nine = failN(LOCKOUT_MAX_FAILURES - 1)!
    expect(nine.failures).toBe(9)
    expect(isLocked(nine, T0 + 9_000)).toBe(false)
    const ten = nextStateAfterFailure(nine, T0 + 10_000)
    expect(isLocked(ten, T0 + 10_000)).toBe(true)
    expect(ten.lockedUntil).toBe(T0 + 10_000 + LOCKOUT_DURATION_MS)
    expect(isLocked(ten, T0 + 10_000 + LOCKOUT_DURATION_MS - 1)).toBe(true)
    expect(isLocked(ten, T0 + 10_000 + LOCKOUT_DURATION_MS)).toBe(false)
  })

  it("lỗi cũ hơn cửa sổ 15 phút không còn được đếm", () => {
    const five = failN(5)!
    const later = nextStateAfterFailure(five, T0 + LOCKOUT_WINDOW_MS + 60_000)
    expect(later.failures).toBe(1)
    expect(later.lockedUntil).toBeNull()
  })

  it("thử tiếp khi đang khoá không kéo dài thời gian khoá", () => {
    const locked = failN(LOCKOUT_MAX_FAILURES)!
    const again = nextStateAfterFailure(locked, T0 + 60_000)
    expect(again).toEqual(locked)
  })

  it("hết khoá thì đếm lại từ đầu", () => {
    const locked = failN(LOCKOUT_MAX_FAILURES)!
    const after = nextStateAfterFailure(locked, locked.lockedUntil! + 1)
    expect(after.failures).toBe(1)
    expect(after.lockedUntil).toBeNull()
  })

  it("thời hạn lưu = max(cuối cửa sổ, hết khoá)", () => {
    const s = failN(3)!
    expect(stateExpiry(s)).toBe(s.windowStart + LOCKOUT_WINDOW_MS)
    const locked = failN(LOCKOUT_MAX_FAILURES)!
    expect(stateExpiry(locked)).toBe(locked.lockedUntil)
  })

  it("parseState bỏ qua dữ liệu hỏng", () => {
    expect(parseState(null)).toBeNull()
    expect(parseState("not json")).toBeNull()
    expect(parseState(JSON.stringify({ failures: "x" }))).toBeNull()
    expect(parseState(JSON.stringify({ failures: 2, windowStart: T0, lockedUntil: null }))).toEqual({
      failures: 2,
      windowStart: T0,
      lockedUntil: null,
    })
  })

  it("tài khoản không có 2FA: khoá theo email (mọi IP) - ngưỡng 50, cao hơn ngưỡng 10 của từng IP", () => {
    expect(LOCKOUT_EMAIL_MAX_FAILURES).toBeGreaterThan(LOCKOUT_MAX_FAILURES)
    const now = T0 + 60_000
    // a single IP reaching 10 failures locks only that (email, IP) pair - the account-wide counter is far from 50
    const oneIp = failN(LOCKOUT_MAX_FAILURES)!
    expect(isLocked(oneIp, now)).toBe(true)
    const emailWide = (n: number) => {
      let s: LockoutState | null = null
      for (let i = 0; i < n; i++) s = nextStateAfterFailure(s, T0 + i * 1000, LOCKOUT_EMAIL_MAX_FAILURES)
      return s
    }
    expect(isLocked(emailWide(LOCKOUT_MAX_FAILURES), now)).toBe(false)
    expect(isLocked(emailWide(LOCKOUT_EMAIL_MAX_FAILURES - 1), now)).toBe(false)
    const locked = emailWide(LOCKOUT_EMAIL_MAX_FAILURES)!
    expect(isLocked(locked, now)).toBe(true)
    expect(isSignInLocked({ emailState: locked, ipState: null, twoFactorEnabled: false, now })).toBe(true)
    expect(isSignInLocked({ emailState: null, ipState: null, twoFactorEnabled: false, now })).toBe(false)
  })

  it("khoá toàn tài khoản không áp dụng cho IP đã đăng nhập thành công gần đây (chủ hệ thống không bị khoá ngoài)", () => {
    const locked = failN(LOCKOUT_MAX_FAILURES)!
    const now = T0 + 20_000
    expect(isSignInLocked({ emailState: locked, ipState: null, twoFactorEnabled: false, knownIp: true, now })).toBe(false)
    // …but the IP's own lock still applies (e.g. the attacker shares the NAT address and guessed 10 times)
    expect(isSignInLocked({ emailState: locked, ipState: locked, twoFactorEnabled: false, knownIp: true, now })).toBe(true)
  })

  it("tài khoản có 2FA: kẻ tấn công không khoá được chủ tài khoản ở IP khác", () => {
    const locked = failN(LOCKOUT_MAX_FAILURES)!
    const now = T0 + 20_000
    // real admin from another IP: email counter locked, but their IP counter is clean → password step allowed
    expect(isSignInLocked({ emailState: locked, ipState: null, twoFactorEnabled: true, now })).toBe(false)
    // the attacker's own IP is locked
    expect(isSignInLocked({ emailState: locked, ipState: locked, twoFactorEnabled: true, now })).toBe(true)
  })

  it("khoá theo email+IP tách biệt theo IP, không chứa IP/email thô", () => {
    const a = lockoutIpKey("admin@example.com", "203.0.113.5")
    const b = lockoutIpKey("admin@example.com", "198.51.100.7")
    expect(a).not.toBe(b)
    expect(a.startsWith(`${lockoutKey("admin@example.com")}:ip:`)).toBe(true)
    expect(a).not.toContain("203.0.113.5")
    expect(lockoutIpKey("admin@example.com", null)).toBe(lockoutIpKey("admin@example.com", "  "))
  })

  it("chuẩn hoá email và khoá lưu trữ không chứa email thô", () => {
    expect(normalizeEmail("  Admin@Example.COM ")).toBe("admin@example.com")
    expect(normalizeEmail("")).toBeNull()
    expect(normalizeEmail(42)).toBeNull()
    const key = lockoutKey("admin@example.com")
    expect(key).toMatch(/^lockout:[0-9a-f]{64}$/)
    expect(key).not.toContain("admin")
  })
})
