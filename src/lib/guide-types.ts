// Client-safe shape of a "Hướng dẫn" (guide) shown in the right-hand guide panel / mobile sheet.
// Plain serialisable data so server pages can pass it to <PageGuide> (src/components/app/page-guide.tsx).
// A provider's ConnectionGuide (src/server/providers/types.ts) is structurally assignable to GuideContent.

export interface GuideStep {
  title: string
  /** short paragraph; "\n" starts a new line */
  detail?: string
  link?: { label: string; url: string }
}

export interface GuideContent {
  /** one-sentence lead */
  summary?: string
  /** numbered steps */
  steps?: readonly GuideStep[]
  /** short bullet tips ("Mẹo") */
  tips?: readonly string[]
  /** highlighted warning box */
  warnings?: readonly string[]
  /** monospace chips (OAuth scopes, permissions…) */
  requiredScopes?: readonly string[]
  /** extra external links, rendered with ↗ */
  links?: readonly { label: string; url: string }[]
}

/** A guide with its panel heading. `id` is derived from the title unless set. */
export interface GuideDef extends GuideContent {
  title: string
  id?: string
}
