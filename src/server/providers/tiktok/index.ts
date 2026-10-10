// TikTok API for Business (Marketing API v1.3) adapter.
// Spec: .claude/docs/providers/tiktok.md · contract: ../types.ts
import type { AdsProvider } from "../types"
import { listTikTokAccounts, validateTikTokCredentials } from "./accounts"
import { copyTikTokObject } from "./copy"
import {
  parseTikTokCredentials,
  tiktokCredentialFields,
  tiktokCredentialHint,
  tiktokGuide,
  type TikTokCredentials,
} from "./credentials"
import { tiktokExtensions } from "./extensions"
import { withGmvMaxReportWarning } from "./gmv-max"
import { tiktokLookup } from "./lookup"
import { uploadTikTokMedia, uploadTikTokVideoChunked } from "./media"
import {
  deleteTikTokObject,
  setTikTokStatus,
  tiktokActivationSpend,
  tiktokMustAlwaysConfirm,
  tiktokPreflightWrite,
  updateTikTokBudget,
  updateTikTokObject,
} from "./mutate"
import { getTikTokObject, listTikTokObjects } from "./objects"
import { getTikTokReport } from "./report"

export const tiktokProvider: AdsProvider<TikTokCredentials> = {
  platform: "tiktok",
  capabilities: {
    report: "native",
    list_objects: "native",
    get_object: "native",
    set_status: "native",
    update_budget: "native", // ad group daily budget: scheduled for next day 00:00 (account TZ)
    update_object: "native", // ad group = GET → merge → full replacement
    copy: "emulated", // official copy task is allowlist-only (gated) → DIY deep copy fallback
    delete: "native",
    upload_media: "native",
    lookup: "native",
    create: "native", // Manual campaigns only; /campaign/create/ closes after 2026-12-31
    update_targeting: "native",
    conversions: "unsupported",
  },
  credentialFields: tiktokCredentialFields,
  guide: tiktokGuide,
  extensions: tiktokExtensions,
  parseCredentials: parseTikTokCredentials,
  credentialHint: tiktokCredentialHint,
  validateCredentials: validateTikTokCredentials,
  listAccounts: listTikTokAccounts,
  // D5: GMV Max spend is not in /report/integrated/get/ → warn when the account has GMV Max campaigns (cached probe)
  getReport: async (ctx, q) => withGmvMaxReportWarning(ctx, await getTikTokReport(ctx, q)),
  listObjects: listTikTokObjects,
  getObject: (ctx, level, id, opts) => getTikTokObject(ctx, level, id, opts),
  setStatus: (ctx, level, ids, status, opts) => setTikTokStatus(ctx, level, ids, status, opts),
  // GMV Max campaigns: status changes always need two-step confirmation (D3)
  mustAlwaysConfirm: (ctx, level, ids, status) => tiktokMustAlwaysConfirm(ctx, level, ids, status),
  // GMV Max campaigns: worst-case daily spend (auto budget / promotion days) checked against the MCP daily cap on enable
  activationSpend: (ctx, level, ids) => tiktokActivationSpend(ctx, level, ids),
  // GMV Max switch off: the "locked" refusal comes before mcp-core's cap checks (S8)
  preflightWrite: (ctx, level, ids, op, opts) => tiktokPreflightWrite(ctx, level, ids, op, opts),
  updateBudget: (ctx, u, opts) => updateTikTokBudget(ctx, u, opts),
  updateObject: (ctx, u, opts) => updateTikTokObject(ctx, u, opts),
  copyObject: (ctx, r, opts) => copyTikTokObject(ctx, r, opts),
  deleteObject: (ctx, level, id, opts) => deleteTikTokObject(ctx, level, id, opts),
  uploadMedia: uploadTikTokMedia,
  uploadVideoChunked: uploadTikTokVideoChunked,
  lookup: tiktokLookup,
}

export { exchangeAuthCode, type ExchangeAuthCodeResult, type TikTokCredentials } from "./credentials"
export { mapTikTokError, tiktokApiVersion } from "./client"
