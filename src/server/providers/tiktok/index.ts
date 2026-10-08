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
import { tiktokLookup } from "./lookup"
import { uploadTikTokMedia } from "./media"
import { deleteTikTokObject, setTikTokStatus, updateTikTokBudget, updateTikTokObject } from "./mutate"
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
  getReport: getTikTokReport,
  listObjects: listTikTokObjects,
  getObject: (ctx, level, id, opts) => getTikTokObject(ctx, level, id, opts),
  setStatus: (ctx, level, ids, status, opts) => setTikTokStatus(ctx, level, ids, status, opts),
  updateBudget: (ctx, u, opts) => updateTikTokBudget(ctx, u, opts),
  updateObject: (ctx, u, opts) => updateTikTokObject(ctx, u, opts),
  copyObject: (ctx, r, opts) => copyTikTokObject(ctx, r, opts),
  deleteObject: (ctx, level, id, opts) => deleteTikTokObject(ctx, level, id, opts),
  uploadMedia: uploadTikTokMedia,
  lookup: tiktokLookup,
}

export { exchangeAuthCode, type ExchangeAuthCodeResult, type TikTokCredentials } from "./credentials"
export { mapTikTokError, tiktokApiVersion } from "./client"
