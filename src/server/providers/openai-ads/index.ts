// OpenAI Ads (ChatGPT Ads) Advertiser API v1 adapter.
// Docs: .claude/docs/providers/openai-ads.md + openai-ads.openapi.json (source of truth).
import type { AdsProvider, Capability, CapabilityMode } from "../types"
import { listAccounts, validateCredentials } from "./accounts"
import { copyObject } from "./copy"
import { credentialFields, credentialHint, guide, parseCredentials, type OpenAIAdsCredentials } from "./credentials"
import { extensions } from "./extensions"
import { lookup } from "./lookup"
import { uploadMedia } from "./media"
import { deleteObject, setStatus, updateBudget, updateObject } from "./mutate"
import { getObject, listObjects } from "./objects"
import { getReport } from "./report"

export type { OpenAIAdsCredentials } from "./credentials"

/**
 * Honest capability map:
 * - delete: native via POST /{type}/{id}/archive - IRREVERSIBLE (no hard delete, no unarchive)
 * - copy: emulated (no native copy; campaign → ad groups → ads re-created paused)
 * - update_budget: campaign level only (no ad-group budgets)
 * - upload_media: images only (video unsupported)
 * - conversions: gated per account (403/404 when not enabled)
 * - update_targeting: no tool exposed for campaign targeting edits yet
 */
export const capabilities: Record<Capability, CapabilityMode> = {
  report: "native",
  list_objects: "native",
  get_object: "native",
  set_status: "native",
  update_budget: "native",
  update_object: "native",
  copy: "emulated",
  delete: "native",
  upload_media: "native",
  lookup: "native",
  create: "native",
  update_targeting: "unsupported",
  conversions: "gated",
}

export const openaiAdsProvider: AdsProvider<OpenAIAdsCredentials> = {
  platform: "openai_ads",
  capabilities,
  credentialFields,
  guide,
  extensions,
  parseCredentials,
  credentialHint,
  validateCredentials,
  listAccounts,
  getReport,
  listObjects,
  getObject,
  setStatus,
  updateBudget,
  updateObject,
  copyObject,
  deleteObject,
  uploadMedia,
  lookup,
}

export default openaiAdsProvider
