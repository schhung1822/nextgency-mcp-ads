import { describe, expect, it } from "vitest"

import { mcp } from "@/lib/i18n/vi/mcp"

import {
  analyzeScope,
  configToFormValues,
  createMcpSchema,
  DEFAULT_SETTINGS_INPUT,
  defaultMcpFormValues,
  expiryDateToIso,
  formValuesToConfig,
  formValuesToCreateInput,
  isoToExpiryDate,
  matchPermissionPreset,
  mcpConfigSchema,
  mcpSettingsSchema,
  missingDailyCapCurrencies,
  MONEY_WRITE_PERMISSIONS,
  normalizePermissions,
  parseAmountText,
  parseIpList,
  pruneChannelsToSelectable,
  pruneDriveSourcesToSelectable,
  pruneToSelectable,
  summarizeScopeIssues,
  toStoredMcpSettings,
  validateNameStep,
  validatePlatformsStep,
  validateProtectionStep,
  type ScopeConfigConnection,
  type ScopeConfigPlatform,
  type ScopeSelectableConnection,
} from "./mcp-servers"

const CONN = "0199a5c8-0000-7000-8000-000000000001"
const ACC = "0199a5c8-0000-7000-8000-000000000002"

describe("mcp-servers schemas", () => {
  it("matches permission sets to the quick presets (order and duplicates ignored)", () => {
    expect(matchPermissionPreset(["read"])).toBe("readOnly")
    expect(matchPermissionPreset([])).toBe("readOnly") // read is implied
    expect(matchPermissionPreset(["update", "status", "read", "status"])).toBe(
      "operate"
    )
    expect(
      matchPermissionPreset(["read", "status", "update", "copy", "create"])
    ).toBe("fullNoDelete")
    // hand-picked or anything with delete is "custom"
    expect(matchPermissionPreset(["read", "copy"])).toBeNull()
    expect(
      matchPermissionPreset([
        "read",
        "status",
        "update",
        "copy",
        "create",
        "delete",
      ])
    ).toBeNull()
  })

  it("always grants read, in canonical order", () => {
    expect(normalizePermissions([])).toEqual(["read"])
    expect(normalizePermissions(["delete", "status", "status"])).toEqual([
      "read",
      "status",
      "delete",
    ])
    const r = createMcpSchema.parse({
      name: " A ",
      platforms: [
        {
          platform: "meta",
          connections: [{ connectionId: CONN, accountIds: null }],
          permissions: ["copy"],
        },
      ],
      settings: {
        twoStepConfirm: true,
        budgetChangeMaxPct: 50,
        maxDailyBudget: {},
        rateLimitPerMin: 60,
        allowedIps: [],
      },
    })
    expect(r.name).toBe("A")
    expect(r.description).toBeNull()
    expect(r.expiresAt).toBeNull()
    expect(r.platforms[0]!.permissions).toEqual(["read", "copy"])
  })

  it("rejects duplicate platforms/connections and empty account picks", () => {
    const base = {
      name: "x",
      settings: {
        twoStepConfirm: true,
        budgetChangeMaxPct: 50,
        maxDailyBudget: {},
        rateLimitPerMin: 60,
        allowedIps: [],
      },
    }
    const p = {
      platform: "meta",
      connections: [{ connectionId: CONN, accountIds: null }],
      permissions: [],
    }
    expect(
      createMcpSchema.safeParse({ ...base, platforms: [p, p] }).success
    ).toBe(false)
    expect(
      createMcpSchema.safeParse({
        ...base,
        platforms: [
          { ...p, connections: [p.connections[0], p.connections[0]] },
        ],
      }).success
    ).toBe(false)
    expect(
      createMcpSchema.safeParse({
        ...base,
        platforms: [
          { ...p, connections: [{ connectionId: CONN, accountIds: [] }] },
        ],
      }).success
    ).toBe(false)
    expect(createMcpSchema.safeParse({ ...base, platforms: [] }).success).toBe(
      false
    )
  })

  it("settings bounds", () => {
    const ok = {
      twoStepConfirm: false,
      budgetChangeMaxPct: 1,
      maxDailyBudget: { USD: 12.5 },
      rateLimitPerMin: 600,
      allowedIps: ["::1"],
    }
    expect(mcpSettingsSchema.safeParse(ok).success).toBe(true)
    expect(
      mcpSettingsSchema.safeParse({ ...ok, budgetChangeMaxPct: 10.5 }).success
    ).toBe(false)
    expect(
      mcpSettingsSchema.safeParse({ ...ok, rateLimitPerMin: 601 }).success
    ).toBe(false)
    expect(
      mcpSettingsSchema.safeParse({
        ...ok,
        allowedIps: Array.from({ length: 51 }, (_, i) => `10.0.0.${i}`),
      }).success
    ).toBe(false)
    expect(toStoredMcpSettings(mcpSettingsSchema.parse(ok))).toEqual({
      two_step_confirm: false,
      budget_change_max_pct: 1,
      max_daily_budget: { USD: 12.5 },
      max_lifetime_budget: {},
      max_bid: {},
      rate_limit_per_min: 600,
      write_rate_limit_per_10min: 20,
      allowed_ips: ["::1"],
      money_caps_required: true,
      telegram_tool: false,
      telegram_notify_writes: false,
      telegram_messages_per_hour: 20,
      drive_public_links: true,
      drive_sheet_writeback: true,
    })
  })

  it("Telegram settings: safe defaults, bounds 1-200, stored snake_case, channel ids optional", () => {
    const base = {
      twoStepConfirm: true,
      budgetChangeMaxPct: 50,
      maxDailyBudget: {},
      rateLimitPerMin: 60,
      allowedIps: [],
    }
    const d = mcpSettingsSchema.parse(base)
    expect([d.telegramTool, d.telegramNotifyWrites, d.telegramMessagesPerHour]).toEqual([false, false, 20])
    for (const bad of [0, 201, 2.5]) {
      expect(mcpSettingsSchema.safeParse({ ...base, telegramMessagesPerHour: bad }).success).toBe(false)
    }
    const s = toStoredMcpSettings(
      mcpSettingsSchema.parse({ ...base, telegramTool: true, telegramNotifyWrites: true, telegramMessagesPerHour: 200 })
    )
    expect([s.telegram_tool, s.telegram_notify_writes, s.telegram_messages_per_hour]).toEqual([true, true, 200])
    // form round trip
    const v = defaultMcpFormValues()
    expect([v.notificationChannelIds, v.telegramTool, v.telegramNotifyWrites, v.telegramMessagesPerHour]).toEqual([[], false, false, "20"])
    v.telegramMessagesPerHour = "0"
    expect(validateProtectionStep(v).telegramMessagesPerHour).toBeDefined()
    v.telegramMessagesPerHour = "50"
    expect(validateProtectionStep(v).telegramMessagesPerHour).toBeUndefined()
    v.notificationChannelIds = [CONN, CONN]
    v.telegramTool = true
    const cfg = formValuesToConfig(v)
    expect(cfg.notificationChannelIds).toEqual([CONN])
    expect(cfg.settings.telegramTool).toBe(true)
    expect(cfg.settings.telegramMessagesPerHour).toBe(50)
    expect(pruneChannelsToSelectable(v, []).notificationChannelIds).toEqual([])
    expect(
      mcpConfigSchema.safeParse({ ...formValuesToConfig(defaultMcpFormValues()), notificationChannelIds: ["x"] }).success
    ).toBe(false)
  })

  it("lifetime/bid caps and write rate limit: defaults, bounds, stored snake_case", () => {
    const base = {
      twoStepConfirm: true,
      budgetChangeMaxPct: 50,
      maxDailyBudget: {},
      rateLimitPerMin: 60,
      allowedIps: [],
    }
    // omitted by older clients → safe defaults
    const d = mcpSettingsSchema.parse(base)
    expect(d.maxLifetimeBudget).toEqual({})
    expect(d.maxBid).toEqual({})
    expect(d.writeRateLimitPer10Min).toBe(20)

    const full = mcpSettingsSchema.parse({
      ...base,
      maxLifetimeBudget: { VND: 150_000_000, USD: 5000 },
      maxBid: { VND: 50_000 },
      writeRateLimitPer10Min: 5,
    })
    expect(toStoredMcpSettings(full)).toMatchObject({
      max_lifetime_budget: { USD: 5000, VND: 150_000_000 },
      max_bid: { VND: 50_000 },
      write_rate_limit_per_10min: 5,
    })
    // keys are sorted for stable diffs
    expect(Object.keys(toStoredMcpSettings(full).max_lifetime_budget)).toEqual([
      "USD",
      "VND",
    ])

    for (const bad of [
      { maxLifetimeBudget: { vnd: 1 } },
      { maxLifetimeBudget: { VND: 0 } },
      { maxBid: { USD: -1 } },
      { maxBid: { USD: Number.NaN } },
      { writeRateLimitPer10Min: 0 },
      { writeRateLimitPer10Min: 1001 },
      { writeRateLimitPer10Min: 2.5 },
    ]) {
      expect(mcpSettingsSchema.safeParse({ ...base, ...bad }).success).toBe(
        false
      )
    }
  })

  it("lifetime/bid caps and write rate limit round-trip through the form", () => {
    const v = defaultMcpFormValues()
    expect(v.writeRateLimitPer10Min).toBe("20")
    v.name = "x"
    v.platforms.meta = {
      enabled: true,
      connections: [{ connectionId: CONN, mode: "all", accountIds: [] }],
      permissions: ["update"],
    }
    v.maxLifetimeBudget = { VND: "150.000.000", USD: "" }
    v.maxBid = { USD: "2,5" }
    v.writeRateLimitPer10Min = "7"
    const input = formValuesToCreateInput(v)
    expect(input.settings.maxLifetimeBudget).toEqual({ VND: 150_000_000 })
    expect(input.settings.maxBid).toEqual({ USD: 2.5 })
    expect(input.settings.writeRateLimitPer10Min).toBe(7)
    const parsed = createMcpSchema.parse(input)
    const back = configToFormValues({ ...parsed, platforms: parsed.platforms })
    expect(back.maxLifetimeBudget).toEqual({ VND: "150000000" })
    expect(back.maxBid).toEqual({ USD: "2.5" })
    expect(back.writeRateLimitPer10Min).toBe("7")

    // stored config written before these fields existed → defaults in the form
    const legacy = configToFormValues({
      ...parsed,
      settings: {
        twoStepConfirm: true,
        budgetChangeMaxPct: 50,
        maxDailyBudget: {},
        rateLimitPerMin: 60,
        allowedIps: [],
      },
    })
    expect(legacy.maxLifetimeBudget).toEqual({})
    expect(legacy.writeRateLimitPer10Min).toBe("20")

    v.maxLifetimeBudget = { VND: "abc" }
    v.maxBid = { USD: "-1" }
    v.writeRateLimitPer10Min = "0"
    expect(Object.keys(validateProtectionStep(v)).sort()).toEqual([
      "maxBid.USD",
      "maxLifetimeBudget.VND",
      "writeRateLimitPer10Min",
    ])
  })

  it("parses amounts and IP lists from form text", () => {
    expect(parseAmountText("5.000.000")).toBe(5_000_000)
    expect(parseAmountText("5000000")).toBe(5_000_000)
    expect(parseAmountText("12,5")).toBe(12.5)
    expect(parseAmountText("12.50")).toBe(12.5)
    expect(parseAmountText("abc")).toBeNaN()
    expect(parseIpList(" 1.2.3.4\n1.2.3.4, 10.0.0.0/8 ;")).toEqual([
      "1.2.3.4",
      "10.0.0.0/8",
    ])
  })

  it("expiry date ↔ ISO (end of day, Asia/Ho_Chi_Minh)", () => {
    expect(expiryDateToIso("2026-12-31")).toBe("2026-12-31T16:59:59.000Z")
    expect(isoToExpiryDate("2026-12-31T16:59:59.000Z")).toBe("2026-12-31")
    expect(expiryDateToIso("31/12/2026")).toBeNull()
  })

  it("form values round-trip to API input and back", () => {
    const v = defaultMcpFormValues()
    v.name = "Báo cáo"
    v.platforms.meta = {
      enabled: true,
      connections: [{ connectionId: CONN, mode: "pick", accountIds: [ACC] }],
      permissions: ["status"],
    }
    v.platforms.openai_ads = {
      enabled: false,
      connections: [],
      permissions: ["read"],
    }
    v.maxDailyBudget = { VND: "5.000.000", USD: "" }
    v.allowedIpsText = "203.0.113.10\n"
    const input = formValuesToCreateInput(v)
    expect(input.platforms).toEqual([
      {
        platform: "meta",
        connections: [{ connectionId: CONN, accountIds: [ACC] }],
        permissions: ["read", "status"],
      },
    ])
    expect(input.settings.maxDailyBudget).toEqual({ VND: 5_000_000 })
    expect(input.settings.allowedIps).toEqual(["203.0.113.10"])
    const parsed = createMcpSchema.parse(input)
    const back = configToFormValues({ ...parsed, platforms: parsed.platforms })
    expect(back.platforms.meta.connections).toEqual([
      { connectionId: CONN, mode: "pick", accountIds: [ACC] },
    ])
    expect(back.maxDailyBudget).toEqual({ VND: "5000000" })
  })

  it("step validators", () => {
    const v = defaultMcpFormValues()
    expect(validateNameStep(v).name).toBeTruthy()
    expect(validatePlatformsStep(v).platforms).toBeTruthy()
    v.platforms.meta = {
      enabled: true,
      connections: [{ connectionId: CONN, mode: "pick", accountIds: [] }],
      permissions: ["read"],
    }
    expect(validatePlatformsStep(v)[`platforms.meta.${CONN}`]).toBeTruthy()
    expect(validateProtectionStep(v)).toEqual({})
    v.budgetChangeMaxPct = "0"
    v.rateLimitPerMin = ""
    v.allowedIpsText = "1.2.3.4\nnope"
    v.maxDailyBudget = { VND: "-5" }
    v.expiresOn = "2000-01-01"
    const e = validateProtectionStep(v)
    expect(Object.keys(e).sort()).toEqual([
      "allowedIps",
      "budgetChangeMaxPct",
      "expiresOn",
      "maxDailyBudget.VND",
      "rateLimitPerMin",
    ])
    expect(
      validateProtectionStep(v, { requireFutureExpiry: false }).expiresOn
    ).toBeUndefined()
  })

  it("rejects control and bidi-override characters in name/description", () => {
    expect(
      validateNameStep({ ...defaultMcpFormValues(), name: "ok\u202Egpj" }).name
    ).toBeTruthy()
    expect(
      validateNameStep({ ...defaultMcpFormValues(), name: "a\u0007b" }).name
    ).toBeTruthy()
    expect(
      validateNameStep({ ...defaultMcpFormValues(), name: "Báo cáo hằng ngày" })
    ).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Scope health (config editor): what the stored scopes point at that is gone
// ---------------------------------------------------------------------------
const cfg = (
  connectionId: string,
  name: string,
  accountIds: string[] | null,
  over: Partial<ScopeConfigConnection> = {}
): ScopeConfigConnection => ({
  connectionId,
  connectionName: name,
  connectionStatus: "active",
  connectionDeleted: false,
  accountIds,
  ...over,
})
const live = (
  id: string,
  platform: ScopeSelectableConnection["platform"],
  accountIds: string[]
): ScopeSelectableConnection => ({
  id,
  platform,
  accounts: accountIds.map((a) => ({ id: a })),
})
const formOf = (platforms: ScopeConfigPlatform[]) =>
  configToFormValues({
    name: "MCP",
    description: null,
    platforms: platforms.map((p) => ({
      platform: p.platform,
      permissions: ["read"],
      connections: p.connections.map((c) => ({
        connectionId: c.connectionId,
        accountIds: c.accountIds,
      })),
    })),
    settings: DEFAULT_SETTINGS_INPUT,
    expiresAt: null,
  })

describe("scope health", () => {
  const config: ScopeConfigPlatform[] = [
    {
      platform: "meta",
      connections: [
        cfg("m1", "BM chính", ["a1", "a2", "a3"]),
        cfg("m2", "Agency", null),
        cfg("m3", "Meta cũ", null, { connectionDeleted: true }),
      ],
    },
    {
      platform: "openai_ads",
      connections: [
        cfg("t1", "OpenAI Ads tạm tắt", null, { connectionStatus: "disabled" }),
      ],
    },
  ]
  // meta m1 lost a2 + a3; m2 has no enabled account; m3 deleted; the OpenAI Ads connection is off and the owner has no other
  const selectable = [live("m1", "meta", ["a1"]), live("m2", "meta", [])]

  it("lists every reference that will be dropped, per platform, with account names when known", () => {
    const a = analyzeScope(config, selectable, { a2: "Shop A2" })
    expect(a.issues).toEqual([
      {
        kind: "accounts_disabled",
        platform: "meta",
        connectionId: "m1",
        connectionName: "BM chính",
        accounts: [
          { id: "a2", name: "Shop A2" },
          { id: "a3", name: null },
        ],
      },
      {
        kind: "connection_deleted",
        platform: "meta",
        connectionId: "m3",
        connectionName: "Meta cũ",
      },
      {
        kind: "connection_unavailable",
        platform: "openai_ads",
        connectionId: "t1",
        connectionName: "OpenAI Ads tạm tắt",
        disabled: true,
      },
    ])
    expect(a.droppedPlatforms).toEqual(["openai_ads"])
    expect(summarizeScopeIssues(a)).toEqual({
      connections: 2,
      accounts: 2,
      platforms: 1,
    })
  })

  it("reports nothing when every reference is still usable", () => {
    const a = analyzeScope(
      [
        {
          platform: "meta",
          connections: [cfg("m1", "BM", ["a1"]), cfg("m2", "Agency", null)],
        },
      ],
      [live("m1", "meta", ["a1", "a9"]), live("m2", "meta", ["b1"])]
    )
    expect(a.issues).toEqual([])
    expect(a.droppedPlatforms).toEqual([])
    expect(a.platforms).toEqual([
      { platform: "meta", usableAccounts: 2, reason: null },
    ])
  })

  it("counts usable accounts per platform and says why there are none", () => {
    const a = analyzeScope(config, selectable)
    expect(a.platforms).toEqual([
      { platform: "meta", usableAccounts: 1, reason: null }, // m1 keeps a1, m2 has none, m3 deleted
      { platform: "openai_ads", usableAccounts: 0, reason: "unavailable" },
    ])
    const reason = (
      platformConfig: ScopeConfigPlatform,
      sel: ScopeSelectableConnection[]
    ) => analyzeScope([platformConfig], sel).platforms[0]?.reason
    const deleted = {
      platform: "meta" as const,
      connections: [cfg("x", "X", null, { connectionDeleted: true })],
    }
    expect(reason(deleted, [])).toBe("deleted")
    // live connection, none of its accounts enabled
    expect(
      reason(
        { platform: "meta", connections: [cfg("x", "X", null)] },
        [live("x", "meta", [])]
      )
    ).toBe("no_accounts")
    // picked accounts all switched off
    expect(
      reason(
        { platform: "meta", connections: [cfg("x", "X", ["a"])] },
        [live("x", "meta", ["b"])]
      )
    ).toBe("no_accounts")
    // one deleted + one switched off → "unavailable" (not every connection is deleted)
    expect(
      reason(
        {
          platform: "meta",
          connections: [
            cfg("x", "X", null, { connectionDeleted: true }),
            cfg("y", "Y", null),
          ],
        },
        []
      )
    ).toBe("unavailable")
  })

  it("ignores a connection listed under another platform than the one it is stored for", () => {
    const a = analyzeScope(
      [{ platform: "meta", connections: [cfg("x", "X", null)] }],
      [live("x", "openai_ads", ["a"])]
    )
    expect(a.issues.map((i) => i.kind)).toEqual(["connection_unavailable"])
    expect(a.platforms[0]?.usableAccounts).toBe(0)
  })

  it("pruneToSelectable drops exactly what analyzeScope reports", () => {
    const pruned = pruneToSelectable(formOf(config), selectable)
    expect(pruned.platforms.meta.connections).toEqual([
      { connectionId: "m1", mode: "pick", accountIds: ["a1"] },
      { connectionId: "m2", mode: "all", accountIds: [] },
    ])
    // no selectable OpenAI Ads connection at all → no card to pick from → switched off instead of an invisible error
    expect(pruned.platforms.openai_ads).toMatchObject({
      enabled: false,
      connections: [],
    })
  })

  it("keeps a platform enabled (and empty) while the owner still has another connection to pick", () => {
    const pruned = pruneToSelectable(
      formOf([
        {
          platform: "openai_ads",
          connections: [
            cfg("t1", "Cũ", null, { connectionDeleted: true }),
          ],
        },
      ]),
      [live("t2", "openai_ads", ["x"])]
    )
    expect(pruned.platforms.openai_ads).toMatchObject({
      enabled: true,
      connections: [],
    })
    // → the platform step then asks for a connection instead of failing silently
    expect(validatePlatformsStep(pruned)["platforms.openai_ads"]).toBeTruthy()
  })

  it("pruning changes the form exactly when there are issues (the save bar opens for both)", () => {
    const meta = (c: ScopeConfigConnection): ScopeConfigPlatform[] => [
      { platform: "meta", connections: [c] },
    ]
    const scenarios: [ScopeConfigPlatform[], ScopeSelectableConnection[]][] = [
      [config, selectable],
      [meta(cfg("m1", "BM", ["a1"])), [live("m1", "meta", ["a1", "a2"])]],
      [meta(cfg("m1", "BM", ["a1"])), [live("m1", "meta", ["a2"])]],
      [meta(cfg("m1", "BM", null)), [live("m1", "meta", [])]],
      [meta(cfg("m1", "BM", null, { connectionDeleted: true })), []],
      [
        [{ platform: "openai_ads", connections: [cfg("o1", "OpenAI", null)] }],
        [live("o1", "openai_ads", ["x"])],
      ],
    ]
    for (const [platforms, sel] of scenarios) {
      const raw = formOf(platforms)
      const a = analyzeScope(platforms, sel)
      const changed =
        JSON.stringify(pruneToSelectable(raw, sel)) !== JSON.stringify(raw)
      expect(changed).toBe(a.issues.length > 0 || a.droppedPlatforms.length > 0)
    }
  })
})

describe("scope health wording", () => {
  const s = mcp.config.scopeIssues
  it("names up to three accounts and counts the rest", () => {
    expect(s.accountsDisabled("BM", ["A"], 0)).toBe(
      'TKQC "A" của kết nối "BM" đã tắt - sẽ bị loại khỏi MCP khi bạn lưu.'
    )
    expect(s.accountsDisabled("BM", ["A", "B", "C", "D", "E"], 1)).toBe(
      'TKQC "A", "B", "C" và 3 TKQC khác của kết nối "BM" đã tắt - sẽ bị loại khỏi MCP khi bạn lưu.'
    )
    expect(s.accountsDisabled("BM", [], 2)).toBe(
      '2 TKQC của kết nối "BM" đã tắt - sẽ bị loại khỏi MCP khi bạn lưu.'
    )
  })

  it("summarises the save-bar counts", () => {
    const sum = mcp.config.prune.summary
    expect(sum({ connections: 1, accounts: 0, platforms: 0 })).toBe("1 kết nối")
    expect(sum({ connections: 2, accounts: 2, platforms: 0 })).toBe(
      "2 kết nối và 2 TKQC"
    )
    expect(sum({ connections: 2, accounts: 3, platforms: 1 })).toBe(
      "2 kết nối, 3 TKQC và 1 nền tảng"
    )
  })
})

describe("Facebook Page scopes", () => {
  const PAGE1 = "0199a5c8-0000-7000-8000-0000000000a1"
  const PAGE2 = "0199a5c8-0000-7000-8000-0000000000a2"
  const metaForm = (pagesMode: "none" | "all" | "pick", pageIds: string[] = []) => {
    const v = defaultMcpFormValues()
    v.name = "Trang"
    v.platforms.meta = {
      enabled: true,
      connections: [{ connectionId: CONN, mode: "all", accountIds: [], pagesMode, pageIds }],
      permissions: ["read"],
    }
    return v
  }

  it("none / all / pick → omitted / null / ids, and back", () => {
    const conn = (v: ReturnType<typeof metaForm>) => formValuesToCreateInput(v).platforms[0]!.connections[0]!
    expect(conn(metaForm("none"))).not.toHaveProperty("pageIds")
    expect(conn(metaForm("all")).pageIds).toBeNull()
    expect(conn(metaForm("pick", [PAGE1])).pageIds).toEqual([PAGE1])
    for (const mode of ["all", "pick"] as const) {
      const parsed = createMcpSchema.parse(formValuesToCreateInput(metaForm(mode, [PAGE1])))
      const back = configToFormValues({ ...parsed, platforms: parsed.platforms })
      expect(back.platforms.meta.connections[0]).toMatchObject({ pagesMode: mode, ...(mode === "pick" ? { pageIds: [PAGE1] } : {}) })
    }
  })

  it("an empty pick is a step error; Pages on another platform are refused by the schema", () => {
    expect(validatePlatformsStep(metaForm("pick"))[`platforms.meta.${CONN}.pages`]).toBe(
      'Chọn ít nhất 1 Trang, hoặc chọn "Tất cả Trang" / "Không dùng Trang".'
    )
    const input = formValuesToCreateInput(metaForm("all"))
    const otherPlatform = { ...input, platforms: [{ ...input.platforms[0]!, platform: "openai_ads" as const }] }
    expect(createMcpSchema.safeParse(otherPlatform).success).toBe(false)
    const otherNoPages = {
      ...input,
      platforms: [{ ...input.platforms[0]!, platform: "openai_ads" as const, connections: [{ connectionId: CONN, accountIds: null, pageIds: [] }] }],
    }
    expect(createMcpSchema.safeParse(otherNoPages).success).toBe(true)
  })

  it("pruneToSelectable drops Pages switched off since (none left → no Page)", () => {
    const selectable: ScopeSelectableConnection[] = [{ id: CONN, platform: "meta", accounts: [], pages: [{ id: PAGE2 }] }]
    const kept = pruneToSelectable(metaForm("pick", [PAGE1, PAGE2]), selectable)
    expect(kept.platforms.meta.connections[0]).toMatchObject({ pagesMode: "pick", pageIds: [PAGE2] })
    const gone = pruneToSelectable(metaForm("pick", [PAGE1]), selectable)
    expect(gone.platforms.meta.connections[0]).toMatchObject({ pagesMode: "none", pageIds: [] })
  })
})

describe("mandatory daily caps", () => {
  it("money-write permissions exclude read and delete", () => {
    expect([...MONEY_WRITE_PERMISSIONS]).toEqual(["status", "update", "copy", "create"])
  })

  it("missingDailyCapCurrencies lists required currencies without a positive cap (upper case, sorted, unique)", () => {
    expect(missingDailyCapCurrencies({ VND: 5_000_000 }, ["VND"])).toEqual([])
    expect(missingDailyCapCurrencies({ VND: 5_000_000 }, ["usd", "VND", "JPY", "USD"])).toEqual(["JPY", "USD"])
    expect(missingDailyCapCurrencies({ VND: 0, USD: Number.NaN }, ["VND", "USD"])).toEqual(["USD", "VND"])
    expect(missingDailyCapCurrencies({}, [])).toEqual([])
  })

  it("stored settings always mark the MCP as 'caps required'", () => {
    expect(toStoredMcpSettings(DEFAULT_SETTINGS_INPUT).money_caps_required).toBe(true)
    // the client cannot set or clear the marker: the schema strips it
    const parsed = mcpSettingsSchema.parse({ ...DEFAULT_SETTINGS_INPUT, moneyCapsRequired: false })
    expect(parsed).not.toHaveProperty("moneyCapsRequired")
  })

  it("validateProtectionStep flags a missing daily cap for each required currency", () => {
    const v = defaultMcpFormValues()
    expect(validateProtectionStep(v, { requiredCapCurrencies: [] })).toEqual({})
    const e = validateProtectionStep(v, { requiredCapCurrencies: ["VND", "USD"] })
    expect(e).toEqual({
      "maxDailyBudget.USD": expect.stringMatching(/USD.*bắt buộc/),
      "maxDailyBudget.VND": expect.stringMatching(/VND.*bắt buộc/),
    })
    // a blank entry is missing, a valid amount is enough, an invalid amount keeps its own message
    v.maxDailyBudget = { VND: "5.000.000", USD: "  " }
    expect(Object.keys(validateProtectionStep(v, { requiredCapCurrencies: ["VND", "USD"] }))).toEqual(["maxDailyBudget.USD"])
    v.maxDailyBudget = { VND: "abc", USD: "10" }
    expect(validateProtectionStep(v, { requiredCapCurrencies: ["VND", "USD"] })).toEqual({
      "maxDailyBudget.VND": "Trần ngân sách phải là số dương hợp lệ.",
    })
    // a lifetime cap does not replace the daily cap
    v.maxDailyBudget = {}
    v.maxLifetimeBudget = { VND: "100.000.000" }
    expect(Object.keys(validateProtectionStep(v, { requiredCapCurrencies: ["VND"] }))).toEqual(["maxDailyBudget.VND"])
  })
})

describe("Google Drive in the MCP config", () => {
  const base = {
    twoStepConfirm: true,
    budgetChangeMaxPct: 50,
    maxDailyBudget: {},
    rateLimitPerMin: 60,
    allowedIps: [],
  }

  it("settings: both switches default ON, explicit false kept, stored snake_case", () => {
    const d = mcpSettingsSchema.parse(base)
    expect([d.drivePublicLinks, d.driveSheetWriteback]).toEqual([true, true])
    const s = toStoredMcpSettings(mcpSettingsSchema.parse({ ...base, drivePublicLinks: false, driveSheetWriteback: false }))
    expect([s.drive_public_links, s.drive_sheet_writeback]).toEqual([false, false])
  })

  it("driveSourceIds: optional, uuids only, at most 50, de-duplicated by the form", () => {
    const cfg = formValuesToConfig(defaultMcpFormValues())
    expect(cfg.driveSourceIds).toEqual([])
    const ids = mcpConfigSchema.shape.driveSourceIds
    expect(ids.safeParse(undefined).success).toBe(true)
    expect(ids.safeParse([CONN]).success).toBe(true)
    expect(ids.safeParse(["x"]).success).toBe(false)
    const many = Array.from({ length: 51 }, (_, i) => `0199a5c8-0000-7000-8000-${String(i).padStart(12, "0")}`)
    expect(ids.safeParse(many).success).toBe(false)
    const v = defaultMcpFormValues()
    expect([v.driveSourceIds, v.drivePublicLinks, v.driveSheetWriteback]).toEqual([[], true, true])
    v.driveSourceIds = [CONN, CONN]
    v.drivePublicLinks = false
    const out = formValuesToConfig(v)
    expect(out.driveSourceIds).toEqual([CONN])
    expect(out.settings.drivePublicLinks).toBe(false)
    expect(out.settings.driveSheetWriteback).toBe(true)
    expect(pruneDriveSourcesToSelectable(v, []).driveSourceIds).toEqual([])
    expect(pruneDriveSourcesToSelectable(v, [{ id: CONN }])).toBe(v)
  })

  it("configToFormValues: rows saved before the feature read the switches as ON", () => {
    const v = configToFormValues({
      name: "x",
      description: null,
      platforms: [],
      settings: { ...base },
      expiresAt: null,
    })
    expect([v.driveSourceIds, v.drivePublicLinks, v.driveSheetWriteback]).toEqual([[], true, true])
    const w = configToFormValues({
      name: "x",
      description: null,
      platforms: [],
      settings: { ...base, drivePublicLinks: false },
      expiresAt: null,
      driveSourceIds: [CONN],
    })
    expect([w.driveSourceIds, w.drivePublicLinks]).toEqual([[CONN], false])
  })
})
