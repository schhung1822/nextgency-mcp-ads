// Text read from Google (names, addresses…) shown to the AI: control / bidi / zero-width / tag characters removed.
import { UNSAFE_TEXT_CHARS } from "../../../lib/text-safety"

export function safeText(v: unknown): string | null {
  return v === undefined || v === null
    ? null
    : String(v).replace(UNSAFE_TEXT_CHARS, "")
}
