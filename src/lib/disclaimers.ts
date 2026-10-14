// In-app disclaimers ("Miễn trừ trách nhiệm") shown as a blocking popup before a user starts adding a connection
// (/connections/new, /connections/telegram/new, /connections/drive/new, /connections/apify/new) or creating an MCP
// (/mcp-servers/new).
// Shared by the server (enforcement + audit) and the client (popup gating). No server imports here.
//
// Shown ONCE per user and kind: after a user accepted the CURRENT version of a text, the popup never shows again to
// that user for that kind (and the create actions accept that acceptance at any time later).
// Changing the TEXT of a disclaimer (src/lib/i18n/vi/disclaimers.ts) requires a new version below: everybody must
// accept the new version again (src/lib/disclaimers.test.ts pins the content hash of every version).
import { z } from "zod"

export const DISCLAIMER_KINDS = ["connection", "mcp"] as const
export type DisclaimerKind = (typeof DISCLAIMER_KINDS)[number]

/** Current version of each text (ISO date it took effect). */
export const DISCLAIMER_VERSIONS: Record<DisclaimerKind, string> = {
  connection: "2026-10-14",
  mcp: "2026-10-10",
}

/** The checkbox stays disabled at least this long after the popup opened (and until the text was scrolled to the end). */
export const DISCLAIMER_MIN_READ_MS = 10_000

/**
 * Pages reached from the /connections/new chooser (Telegram, Google Drive, Apify) are the same "Thêm kết nối" flow. Their
 * server component already finds the acceptance just given on the chooser; as a client-side fallback (e.g. a page
 * payload rendered before the acceptance) the chooser also hands it over (one-shot, same tab, this long).
 */
export const DISCLAIMER_HANDOFF_MS = 2 * 60 * 1000
export const DISCLAIMER_HANDOFF_KEY = "adsmcp.disclaimer.handoff"

export const acceptDisclaimerSchema = z.object({
  kind: z.enum(DISCLAIMER_KINDS),
  version: z.string().trim().min(1).max(32),
})
export type AcceptDisclaimerInput = z.infer<typeof acceptDisclaimerSchema>

export function isCurrentDisclaimerVersion(
  kind: DisclaimerKind,
  version: string
): boolean {
  return DISCLAIMER_VERSIONS[kind] === version
}

/** "2026-10-10" → "10/10/2026" (version line of the popup). */
export function disclaimerVersionDate(version: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : version
}

export interface DisclaimerGateInput {
  /** the end of the text has been visible inside the scroll region at least once */
  reachedEnd: boolean
  /** epoch ms when the popup opened */
  openedAt: number
  now: number
  checked: boolean
  pending?: boolean
  minReadMs?: number
}

export interface DisclaimerGateState {
  /** whole seconds still to wait (0 = minimum time is over) */
  secondsLeft: number
  /** scrolled to the end AND waited the minimum time: the checkbox can be ticked */
  canCheck: boolean
  /** the checkbox is ticked (and still allowed) and nothing is being sent: the confirm button is enabled */
  canConfirm: boolean
}

/** Pure gating rule of the popup: read to the end + minimum reading time → checkbox → confirm. */
export function disclaimerGate(s: DisclaimerGateInput): DisclaimerGateState {
  const min = s.minReadMs ?? DISCLAIMER_MIN_READ_MS
  const elapsed = Math.max(0, s.now - s.openedAt)
  const secondsLeft = elapsed >= min ? 0 : Math.ceil((min - elapsed) / 1000)
  const canCheck = s.reachedEnd && secondsLeft === 0
  return {
    secondsLeft,
    canCheck,
    canConfirm: canCheck && s.checked && !s.pending,
  }
}

/** Percentage (0-100, whole number) of a scroll region already seen; a region without overflow counts as 100. */
export function readProgress(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): number {
  const max = scrollHeight - clientHeight
  if (!(max > 1)) return 100
  return Math.min(100, Math.max(0, Math.round((scrollTop / max) * 100)))
}

export interface DisclaimerHandoff {
  kind: DisclaimerKind
  version: string
  /** epoch ms of the click on the chooser card */
  at: number
  /** pathname of the page the acceptance is handed to */
  to: string
}

/** Whether a stored handoff (JSON from sessionStorage) is valid for this page right now. */
export function handoffAccepted(
  raw: string | null,
  kind: DisclaimerKind,
  pathname: string,
  now: number
): boolean {
  if (!raw) return false
  let h: Partial<DisclaimerHandoff>
  try {
    h = JSON.parse(raw) as Partial<DisclaimerHandoff>
  } catch {
    return false
  }
  if (h.kind !== kind || h.to !== pathname) return false
  if (
    typeof h.version !== "string" ||
    !isCurrentDisclaimerVersion(kind, h.version)
  )
    return false
  if (typeof h.at !== "number" || !Number.isFinite(h.at)) return false
  const age = now - h.at
  return age >= 0 && age <= DISCLAIMER_HANDOFF_MS
}
