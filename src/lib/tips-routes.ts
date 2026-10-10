// Routes of the "Mẹo sử dụng" pages (/tips/<slug>). Pure + client-safe. The redirects /tips → /tips/automation and
// /automation-tips (old link) → /tips/automation live in next.config.ts.

export const TIP_SLUGS = ["automation", "bulk-ads", "ad-check"] as const
export type TipSlug = (typeof TIP_SLUGS)[number]

/** URL prefix shared by every tip (sidebar item active on all of them). */
export const TIPS_ROOT = "/tips"

export function tipHref(slug: TipSlug): string {
  return `${TIPS_ROOT}/${slug}`
}

/** Where the sidebar item and /tips lead. */
export const DEFAULT_TIP_HREF = tipHref("automation")
