// Google Ads API (REST) adapter - plain fetch, no gRPC / google-ads-api library.
// Version: process.env.GOOGLE_ADS_API_VERSION ?? "v25". Spec: .claude/docs/providers/google-ads.md
import type { AdsProvider, Capability, CapabilityMode } from "../types"
import { listAccounts, validateCredentials } from "./accounts"
import { copyObject } from "./copy"
import { credentialFields, credentialHint, guide, parseCredentials, type GoogleAdsCredentials } from "./credentials"
import { googleAdsExtensions } from "./extensions"
import { lookup } from "./lookup"
import { uploadMedia } from "./media"
import { deleteObject, setStatus, updateBudget, updateObject } from "./mutate"
import { getObject, listObjects } from "./objects"
import { getReport } from "./report"

/**
 * Honest capability map:
 * - copy: emulated (GAQL read + one googleAds:mutate with temp ids); Search campaigns / ad groups / RSA ads only - PMax and other channels unsupported.
 * - upload_media: images (SSRF-guarded bytes from mcp-core only) + YouTube videos as YoutubeVideoAsset from a YouTube
 *   URL / 11-char id (no file upload; also via the google_ads_add_youtube_video extension). Resumable upload: later.
 * - create: Search campaigns, RSA, keywords via extensions; Performance Max / Video / Demand Gen creation unsupported.
 * - YouTube: VIDEO campaigns are read-only (report / list / get only; every write is refused with "unsupported"),
 *   DEMAND_GEN campaigns are manageable (status / budget / bids). Report + list accept the Google-only optional
 *   filter `channelTypes` (youtube | VIDEO | DEMAND_GEN | PERFORMANCE_MAX | SEARCH…) and the report `adNetworkTypes`.
 * - update_targeting / conversions: no tool in v1.
 */
export const GOOGLE_ADS_CAPABILITIES: Record<Capability, CapabilityMode> = {
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
  conversions: "unsupported",
}

export const googleAdsProvider: AdsProvider<GoogleAdsCredentials> = {
  platform: "google_ads",
  capabilities: GOOGLE_ADS_CAPABILITIES,
  credentialFields,
  guide,
  extensions: googleAdsExtensions,
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

export type { GoogleAdsCredentials } from "./credentials"
export { apiVersion } from "./client"
