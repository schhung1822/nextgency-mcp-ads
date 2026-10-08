import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import adFixture from "./__fixtures__/ad_get.json"
import advertiserInfo from "./__fixtures__/advertiser_info.json"
import { CREDS, fail, makeCtx, mockTikTok, ok } from "./__fixtures__/mock-fetch"
import { normalizeStatus } from "./api"
import { tiktokProvider } from "./index"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

describe("credentials", () => {
  it("parseCredentials yêu cầu đủ accessToken, appId (số), secret", () => {
    expect(tiktokProvider.parseCredentials({ accessToken: " t ", appId: "123", secret: "s" })).toEqual({ accessToken: "t", appId: "123", secret: "s" })
    expect(() => tiktokProvider.parseCredentials({ accessToken: "t", appId: "abc", secret: "s" })).toThrow()
    expect(() => tiktokProvider.parseCredentials({ accessToken: "t", appId: "1" })).toThrow()
    expect(tiktokProvider.credentialHint(CREDS)).toBe("…3456")
    expect(tiktokProvider.credentialFields.map((f) => f.key)).toEqual(["accessToken", "appId", "secret"])
    expect(tiktokProvider.guide.steps.some((s) => s.detail.includes("auth_code"))).toBe(true)
  })
})

describe("validate & list accounts", () => {
  it("token sai (HTTP 200 + 40105) → valid=false, không ném lỗi", async () => {
    mockTikTok({ "GET /user/info/": fail(40105, "Access token is incorrect") })
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS })
    expect(res.valid).toBe(false)
    expect(res.warnings[0]).toContain("Access token")
  })

  it("token hợp lệ: gọi /user/info/ rồi /oauth2/advertiser/get/ với app_id + secret", async () => {
    const m = mockTikTok({
      "GET /user/info/": ok({ core_user_id: "7000", display_name: "ads-admin" }),
      "GET /oauth2/advertiser/get/": ok({ list: [{ advertiser_id: "1", advertiser_name: "A" }] }),
    })
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS, connectionMeta: { scope: [1, 2, 4] } })
    expect(res.valid).toBe(true)
    expect(res.tokenExpiresAt).toBeNull()
    expect(res.scopes).toEqual(["Ad Account Management", "Ads Management", "Reporting"])
    expect(res.warnings.some((w) => w.includes("Creative Management"))).toBe(true)
    const adv = m.callsTo("GET /oauth2/advertiser/get/")[0]!
    expect(adv.query).toMatchObject({ app_id: CREDS.appId, secret: CREDS.secret })
    expect(JSON.stringify(res.meta)).not.toContain(CREDS.secret)
  })

  it("listAccounts: map tiền tệ, múi giờ IANA, trạng thái", async () => {
    const m = mockTikTok({
      "GET /oauth2/advertiser/get/": ok({
        list: [
          { advertiser_id: "7100000000000000001", advertiser_name: "A" },
          { advertiser_id: "7100000000000000002", advertiser_name: "B" },
        ],
      }),
      "GET /advertiser/info/": { body: advertiserInfo },
    })
    const accounts = await tiktokProvider.listAccounts({ credentials: CREDS })
    expect(accounts).toEqual([
      expect.objectContaining({
        externalId: "7100000000000000001",
        name: "Shop ABC - VN",
        currency: "VND",
        // `timezone` (account time zone, GMT offset) wins over display_timezone (display name only)
        timezone: "Etc/GMT-7",
        status: "active",
        statusRaw: "STATUS_ENABLE",
        parentExternalId: "7000000000000000777",
      }),
      expect.objectContaining({ externalId: "7100000000000000002", currency: "USD", timezone: "America/Los_Angeles", status: "disabled" }),
    ])
    expect(accounts[0]!.extra!.balance).toBe(12500000)
    expect(accounts[0]!.extra!.displayTimezone).toBe("Asia/Ho_Chi_Minh")
    expect(m.callsTo("GET /advertiser/info/")[0]!.query.advertiser_ids).toEqual(["7100000000000000001", "7100000000000000002"])
  })

  it("listAccounts: thiếu currency → bỏ qua tài khoản (không mặc định USD); tất cả thiếu → lỗi", async () => {
    const [vn, us] = advertiserInfo.data.list
    mockTikTok({
      "GET /oauth2/advertiser/get/": ok({ list: [{ advertiser_id: vn!.advertiser_id }, { advertiser_id: us!.advertiser_id }] }),
      "GET /advertiser/info/": ok({ list: [vn, { ...us, currency: "" }] }),
    })
    const accounts = await tiktokProvider.listAccounts({ credentials: CREDS })
    expect(accounts.map((a) => a.externalId)).toEqual(["7100000000000000001"])

    mockTikTok({
      "GET /oauth2/advertiser/get/": ok({ list: [{ advertiser_id: us!.advertiser_id }] }),
      "GET /advertiser/info/": ok({ list: [{ ...us, currency: undefined }] }),
    })
    await expect(tiktokProvider.listAccounts({ credentials: CREDS })).rejects.toMatchObject({ code: "upstream_error" })
  })
})

describe("objects", () => {
  it("chuẩn hoá trạng thái operation_status/secondary_status", () => {
    expect(normalizeStatus("ENABLE", "AD_STATUS_DELIVERY_OK")).toBe("active")
    expect(normalizeStatus("DISABLE", "AD_STATUS_DISABLE")).toBe("paused")
    expect(normalizeStatus("DELETE", "AD_STATUS_DELETE")).toBe("deleted")
    expect(normalizeStatus("ENABLE", "ADGROUP_STATUS_CAMPAIGN_DELETE")).toBe("deleted")
    // child ENABLE under a disabled parent is not delivering → paused (not active)
    expect(normalizeStatus("ENABLE", "ADGROUP_STATUS_CAMPAIGN_DISABLE")).toBe("paused")
    expect(normalizeStatus("ENABLE", "AD_STATUS_ADGROUP_DISABLE")).toBe("paused")
    expect(normalizeStatus("ENABLE", "AD_STATUS_CAMPAIGN_DISABLE")).toBe("paused")
    expect(normalizeStatus("ENABLE", "ADGROUP_STATUS_DELIVERY_OK")).toBe("active")
    expect(normalizeStatus("ENABLE", "AD_STATUS_AUDIT_DENY")).toBe("rejected")
    expect(normalizeStatus("ENABLE", "AD_STATUS_AUDIT")).toBe("pending_review")
    expect(normalizeStatus("ENABLE", "ADGROUP_STATUS_TIME_DONE")).toBe("archived")
    expect(normalizeStatus("FROZEN", "")).toBe("disabled")
  })

  it("listObjects ad: exclude NULL_FIELD, lọc theo ad group, ngân sách/ trạng thái", async () => {
    const m = mockTikTok({ "GET /ad/get/": { body: adFixture } })
    const page = await tiktokProvider.listObjects(makeCtx(), { level: "ad", parentId: "1810000000000000101", limit: 50 })
    expect(page.items.map((i) => [i.id, i.status, i.parentId])).toEqual([
      ["1810000000000001001", "active", "1810000000000000101"],
      ["1810000000000001002", "paused", "1810000000000000101"],
    ])
    const q = m.calls[0]!.query
    expect(q.exclude_field_types_in_response).toEqual(["NULL_FIELD"])
    expect(q.filtering).toEqual({ primary_status: "STATUS_NOT_DELETE", adgroup_ids: ["1810000000000000101"] })
    expect(page.nextCursor).toBeNull()
  })

  it("getObject ad group kèm cây con; ngân sách đơn vị chính", async () => {
    const adgroupFixture = (await import("./__fixtures__/adgroup_get.json")).default
    mockTikTok({ "GET /adgroup/get/": { body: adgroupFixture }, "GET /ad/get/": { body: adFixture } })
    const d = await tiktokProvider.getObject(makeCtx(), "ad_group", "1810000000000000101", { includeChildren: true })
    expect(d.budget).toEqual({ type: "daily", amount: 500000, currency: "VND", level: "ad_group" })
    expect(d.startTime).toBe("2026-09-20T17:00:00.000Z")
    expect(d.endTime).toBeNull()
    expect(d.children).toHaveLength(2)
    expect(d.config.location_ids).toEqual(["1562822"])
  })

  it("capabilities khai báo trung thực", () => {
    expect(tiktokProvider.platform).toBe("tiktok")
    expect(tiktokProvider.capabilities.copy).toBe("emulated")
    expect(tiktokProvider.capabilities.conversions).toBe("unsupported")
  })
})
