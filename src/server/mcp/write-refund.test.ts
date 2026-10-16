// D5 (v1.1.6): when may a refused write give its write-limit slot back? Fail closed everywhere.
import { describe, expect, it } from "vitest"

import { ProviderError, type ProviderErrorCode } from "../providers/errors"
import type { Platform } from "../providers/types"
import { McpToolError } from "./errors"
import {
  ATOMIC_WRITE_TOOLS,
  isDefiniteNoChange,
  isWriteRequest,
  REFUNDABLE_CODES,
  UpstreamWriteTracker,
  type UpstreamWrites,
} from "./write-refund"

const NO_UPSTREAM: UpstreamWrites = {
  writes: 0,
  unclearEarlierWrites: 0,
  lastIsWrite: false,
  lastWriteStatus: null,
}

function pe(
  code: ProviderErrorCode,
  o: {
    upstream?: boolean
    audit?: boolean
    platform?: Platform
    upstreamCode?: number | null
    httpStatus?: number | null
  } = {}
) {
  return new ProviderError({
    platform: o.platform ?? "meta",
    code,
    message: "m",
    userMessageVi: "v",
    upstream:
      o.upstream === false
        ? undefined
        : {
            code: o.upstreamCode === undefined ? 100 : o.upstreamCode,
            httpStatus: o.httpStatus === undefined ? 400 : o.httpStatus,
          },
    audit: o.audit ? { errorCode: "x", changes: [] } : undefined,
  })
}

/** Run a list of upstream requests through a tracker and return what happened after the mark. */
function track(
  events: {
    method: string
    url?: string
    status: number
    platform?: Platform
  }[],
  before: typeof events = []
) {
  const t = new UpstreamWriteTracker()
  const ev = (e: (typeof events)[number]) =>
    t.observe({
      platform: e.platform ?? "meta",
      method: e.method,
      url: e.url ?? "https://graph.facebook.com/v26.0/123",
      status: e.status,
    })
  before.forEach(ev)
  const mark = t.mark()
  events.forEach(ev)
  return t.since(mark)
}

describe("isDefiniteNoChange - codes, tools, error origin", () => {
  const refusedPost = track([{ method: "POST", status: 400 }])

  it("refunds every refundable platform refusal on a single-step write tool", () => {
    for (const tool of ATOMIC_WRITE_TOOLS) {
      for (const code of REFUNDABLE_CODES)
        expect(isDefiniteNoChange(pe(code), tool, refusedPost)).toBe(true)
    }
  })

  it("never refunds uncertain / transient / other codes", () => {
    const others: ProviderErrorCode[] = [
      "upstream_error",
      "timeout",
      "unknown",
      "conflict",
      "not_found",
      "unsupported",
      "feature_not_enabled",
      "invalid_credentials_input",
    ]
    for (const code of others)
      expect(isDefiniteNoChange(pe(code), "ads_set_status", refusedPost)).toBe(
        false
      )
  })

  it("never refunds multi-step / create / copy / upload tools, extensions outside the list, Apify or Drive", () => {
    for (const tool of [
      "meta_create_campaign",
      "ads_copy_object",
      "ads_upload_media",
      "tiktok_create_smart_plus",
      "apify_run_task",
      "drive_sheet_update_rows",
      "meta_create_ad",
    ])
      expect(isDefiniteNoChange(pe("rate_limited"), tool, refusedPost)).toBe(
        false
      )
  })

  it("never refunds an MCP refusal (the AI's input), a non-provider error or an uncertain write (audit)", () => {
    expect(
      isDefiniteNoChange(
        new McpToolError({ code: "budget_cap", messageVi: "x" }),
        "ads_update_budget",
        NO_UPSTREAM
      )
    ).toBe(false)
    expect(
      isDefiniteNoChange(
        new Error("socket hang up"),
        "ads_set_status",
        NO_UPSTREAM
      )
    ).toBe(false)
    expect(
      isDefiniteNoChange(new RangeError("bad"), "ads_set_status", NO_UPSTREAM)
    ).toBe(false)
    expect(
      isDefiniteNoChange(
        pe("rate_limited", { audit: true }),
        "ads_set_status",
        refusedPost
      )
    ).toBe(false)
  })

  it("invalid_request counts only when the PLATFORM said so (adapter validation of the AI's input does not)", () => {
    expect(
      isDefiniteNoChange(
        pe("invalid_request", { upstream: false }),
        "ads_update_object",
        NO_UPSTREAM
      )
    ).toBe(false)
    expect(
      isDefiniteNoChange(
        pe("invalid_request", { upstreamCode: null, httpStatus: null }),
        "ads_update_object",
        NO_UPSTREAM
      )
    ).toBe(false)
    expect(
      isDefiniteNoChange(
        pe("invalid_request"),
        "ads_update_object",
        refusedPost
      )
    ).toBe(true)
  })

  it("unknown upstream activity (no tracker) → no refund", () => {
    expect(isDefiniteNoChange(pe("rate_limited"), "ads_set_status", null)).toBe(
      false
    )
  })
})

describe("isDefiniteNoChange - what was sent upstream", () => {
  const rl = pe("rate_limited")

  it("no write sent (local throttle, pre-read refused) → refund", () => {
    expect(
      isDefiniteNoChange(
        pe("rate_limited", { upstream: false }),
        "ads_set_status",
        track([])
      )
    ).toBe(true)
    expect(
      isDefiniteNoChange(
        pe("permission_denied"),
        "ads_set_status",
        track([{ method: "GET", status: 403 }])
      )
    ).toBe(true)
  })

  it("one write refused by HTTP status and it is the last request → refund", () => {
    expect(
      isDefiniteNoChange(
        rl,
        "ads_set_status",
        track([
          { method: "GET", status: 200 },
          { method: "POST", status: 429 },
        ])
      )
    ).toBe(true)
  })

  it("TikTok: HTTP 200 + error envelope (upstream code) on the last write → refund; 200 without a platform code → no", () => {
    const tt = (upstreamCode: number | null) =>
      pe("rate_limited", { platform: "tiktok", upstreamCode, httpStatus: 200 })
    const ttPost = track([
      {
        platform: "tiktok",
        method: "POST",
        url: "https://business-api.tiktok.com/open_api/v1.3/campaign/status/update/",
        status: 200,
      },
    ])
    expect(isDefiniteNoChange(tt(40100), "ads_set_status", ttPost)).toBe(true)
    expect(isDefiniteNoChange(tt(null), "ads_set_status", ttPost)).toBe(false)
    expect(
      isDefiniteNoChange(
        pe("permission_denied", { upstream: false }),
        "ads_set_status",
        ttPost
      )
    ).toBe(false)
  })

  it("a read after the write (read-back) → the write may have succeeded → no refund", () => {
    expect(
      isDefiniteNoChange(
        rl,
        "ads_update_object",
        track([
          { method: "POST", status: 200 },
          { method: "GET", status: 429 },
        ])
      )
    ).toBe(false)
    expect(
      isDefiniteNoChange(
        rl,
        "ads_update_object",
        track([
          { method: "POST", status: 400 },
          { method: "GET", status: 429 },
        ])
      )
    ).toBe(false)
  })

  it("a network failure / timeout on a write (status 0) → the platform may have applied it → no refund", () => {
    expect(
      isDefiniteNoChange(
        rl,
        "ads_set_status",
        track([{ method: "POST", status: 0 }])
      )
    ).toBe(false)
    // adapter retry: timeout, then 429 → the first attempt may have been applied
    expect(
      isDefiniteNoChange(
        rl,
        "ads_set_status",
        track([
          { method: "POST", status: 0 },
          { method: "POST", status: 429 },
        ])
      )
    ).toBe(false)
    // 5xx then 429: same
    expect(
      isDefiniteNoChange(
        rl,
        "ads_set_status",
        track([
          { method: "POST", status: 503 },
          { method: "POST", status: 429 },
        ])
      )
    ).toBe(false)
  })

  it("several writes: refund only when every one of them was refused (e.g. 429 retried, all ids refused)", () => {
    expect(
      isDefiniteNoChange(
        rl,
        "ads_set_status",
        track([
          { method: "POST", status: 429 },
          { method: "POST", status: 429 },
        ])
      )
    ).toBe(true)
    // one write succeeded (2xx) before the failing one → something changed → no refund
    expect(
      isDefiniteNoChange(
        rl,
        "ads_set_status",
        track([
          { method: "POST", status: 200 },
          { method: "POST", status: 429 },
        ])
      )
    ).toBe(false)
  })

  it("only the requests after the mark count (budget pre-checks of the same call are ignored)", () => {
    expect(
      isDefiniteNoChange(
        rl,
        "ads_update_budget",
        track(
          [{ method: "POST", status: 429 }],
          [{ method: "POST", status: 0 }]
        )
      )
    ).toBe(true)
  })

  it("Google: GAQL search and OAuth refresh are reads; a mutate is a write", () => {
    const g = (url: string) => ({
      platform: "google_ads" as const,
      method: "POST",
      url,
    })
    expect(
      isWriteRequest(
        g("https://googleads.googleapis.com/v25/customers/123/googleAds:search")
      )
    ).toBe(false)
    expect(
      isWriteRequest(
        g(
          "https://googleads.googleapis.com/v25/customers/123/googleAds:searchStream"
        )
      )
    ).toBe(false)
    expect(isWriteRequest(g("https://oauth2.googleapis.com/token"))).toBe(false)
    expect(
      isWriteRequest(
        g("https://googleads.googleapis.com/v25/customers/123/campaigns:mutate")
      )
    ).toBe(true)
    expect(isWriteRequest(g("not a url"))).toBe(true)
    // other platforms: any non-GET is a write (fail closed)
    expect(
      isWriteRequest({
        platform: "meta",
        method: "GET",
        url: "https://graph.facebook.com/x",
      })
    ).toBe(false)
    expect(
      isWriteRequest({
        platform: "meta",
        method: "POST",
        url: "https://graph.facebook.com/x/googleAds:search",
      })
    ).toBe(true)
    expect(
      isWriteRequest({
        platform: "openai_ads",
        method: "DELETE",
        url: "https://api.openai.com/v1/x",
      })
    ).toBe(true)
    const refresh = track([
      {
        platform: "google_ads",
        method: "POST",
        url: "https://oauth2.googleapis.com/token",
        status: 200,
      },
      {
        platform: "google_ads",
        method: "POST",
        url: "https://googleads.googleapis.com/v25/customers/1/campaigns:mutate",
        status: 429,
      },
    ])
    expect(
      isDefiniteNoChange(
        pe("rate_limited", { platform: "google_ads" }),
        "ads_set_status",
        refresh
      )
    ).toBe(true)
  })
})

describe("isDefiniteNoChange - security follow-ups", () => {
  const refusedPost = track([{ method: "POST", status: 400 }])

  it("a refusal for suspected abuse (Meta 368, any subcode) is never refunded", () => {
    const abuse = (code: number | string) =>
      new ProviderError({ platform: "meta", code: "rate_limited", message: "m", userMessageVi: "v", upstream: { code, subcode: 1390008, httpStatus: 400 } })
    expect(isDefiniteNoChange(abuse(368), "ads_set_status", refusedPost)).toBe(false)
    expect(isDefiniteNoChange(abuse("368"), "ads_update_budget", refusedPost)).toBe(false)
    expect(isDefiniteNoChange(abuse(368), "ads_update_object", track([]))).toBe(false)
    // an ordinary Meta throttle (17 / 613) still is; 368 on another platform is not Meta's abuse code
    expect(isDefiniteNoChange(abuse(17), "ads_set_status", refusedPost)).toBe(true)
    const tt = new ProviderError({ platform: "tiktok", code: "rate_limited", message: "m", userMessageVi: "v", upstream: { code: 368, httpStatus: 200 } })
    expect(isDefiniteNoChange(tt, "ads_set_status", track([{ platform: "tiktok", method: "POST", status: 200 }]))).toBe(true)
  })

  it("a rejected batch (4xx) whose sub-operations have an unknown outcome (audit attached by the adapter) is never refunded", () => {
    for (const code of ["rate_limited", "invalid_request", "permission_denied"] as const) {
      const batch = new ProviderError({
        platform: "google_ads",
        code,
        message: "partial failure",
        userMessageVi: "v",
        upstream: { code: "RESOURCE_EXHAUSTED", httpStatus: 400 },
        audit: { errorCode: "batch_unknown_outcome", changes: [{ objectId: "1", field: "status", before: "ENABLED", after: "PAUSED" }] },
      })
      // the tracker alone would allow it (one write, refused 4xx, last request)
      expect(isDefiniteNoChange(batch, "ads_set_status", refusedPost)).toBe(false)
    }
    // same shape seen from the wire: one sub-request timed out (status 0) before the refused one → no refund even without audit
    const wire = track([{ method: "POST", status: 0 }, { method: "POST", status: 400 }])
    expect(isDefiniteNoChange(pe("invalid_request"), "ads_set_status", wire)).toBe(false)
  })
})
