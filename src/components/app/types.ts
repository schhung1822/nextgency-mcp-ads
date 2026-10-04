// Client-safe mirrors of shared server types. Derived from @/lib/constants (which is typed against
// @/server/providers/types and @/server/mcp/types), so they cannot drift from the source of truth.
import type { PERMISSION_LABELS, PLATFORM_LABELS } from "@/lib/constants"

/** Same as Platform in @/lib/platforms (every platform the DB knows; see RELEASED_PLATFORMS) */
export type Platform = keyof typeof PLATFORM_LABELS

/** "read" | "status" | "update" | "copy" | "create" | "delete" - same as Permission in @/server/mcp/types */
export type Permission = keyof typeof PERMISSION_LABELS

/** Structurally identical to ConnectionGuide in @/server/providers/types (a provider's `guide` is assignable). */
export interface ConnectionGuide {
  summary: string
  steps: {
    title: string
    detail: string
    link?: { label: string; url: string }
  }[]
  requiredScopes?: string[]
  warnings?: string[]
}
