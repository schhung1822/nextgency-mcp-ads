// Meta (Facebook/Instagram) Marketing API adapter. Spec: .claude/docs/providers/meta.md
import type { AdsProvider } from "../types"
import { listMetaAccounts, prepareMetaCredentials, validateMetaCredentials } from "./accounts"
import type { MetaCredentials } from "./client"
import { copyMetaObject } from "./copy"
import { metaCredentialFields, metaCredentialHint, metaGuide, parseMetaCredentials } from "./credentials"
import { metaExtensions } from "./extensions"
import { metaLookup } from "./lookup"
import { uploadMetaMedia, uploadMetaVideoChunked } from "./media"
import { deleteMetaObject, setMetaStatus, updateMetaBudget, updateMetaObject } from "./mutate"
import { getMetaObject, listMetaObjects } from "./objects"
import { listMetaPages } from "./pages"
import { getMetaReport } from "./report"

export type { MetaCredentials } from "./client"
export { appSecretProof, mapGraphError, metaApiVersion } from "./client"
export type { MetaWriteResult } from "./extensions"

export const metaProvider: AdsProvider<MetaCredentials> = {
  platform: "meta",
  capabilities: {
    report: "native",
    list_objects: "native",
    get_object: "native",
    set_status: "native",
    update_budget: "native",
    update_object: "native",
    // native /copies endpoints; deep campaign copies are orchestrated (shallow + per ad set/ad) to stay under the
    // 3-ad synchronous deep-copy limit
    copy: "native",
    delete: "native",
    upload_media: "native",
    lookup: "native",
    create: "native",
    update_targeting: "native",
    // Conversions API (server events) is not implemented in this adapter
    conversions: "unsupported",
  },
  credentialFields: metaCredentialFields,
  guide: metaGuide,
  extensions: metaExtensions,
  parseCredentials: parseMetaCredentials,
  credentialHint: metaCredentialHint,
  prepareCredentials: prepareMetaCredentials,
  validateCredentials: validateMetaCredentials,
  listAccounts: listMetaAccounts,
  listPages: listMetaPages,
  getReport: getMetaReport,
  listObjects: listMetaObjects,
  getObject: getMetaObject,
  setStatus: setMetaStatus,
  updateBudget: updateMetaBudget,
  updateObject: updateMetaObject,
  copyObject: copyMetaObject,
  deleteObject: deleteMetaObject,
  uploadMedia: uploadMetaMedia,
  uploadVideoChunked: uploadMetaVideoChunked,
  lookup: metaLookup,
}
