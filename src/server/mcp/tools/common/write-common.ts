// Shared bits of the common write tools.
import type { MutationResult } from "../../../providers/types"
import { previewChanges, type PreviewInfo } from "../../confirm"
import { changesForLog } from "../../logging"

export function previewFromMutation(r: MutationResult, extraWarnings: string[] = [], details?: Record<string, unknown>): PreviewInfo {
  return {
    changes: previewChanges(r.changes),
    warnings: [...extraWarnings, ...(r.warnings ?? [])],
    effective_at: r.effectiveAt ?? null,
    ...(details ? { details } : {}),
  }
}

export function mutationOut(r: MutationResult, extraWarnings: string[] = []) {
  return {
    changes: (changesForLog(r.changes) ?? []) as unknown as Record<string, unknown>[],
    warnings: [...extraWarnings, ...(r.warnings ?? [])],
    effective_at: r.effectiveAt ?? null,
  }
}
