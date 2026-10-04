// Shared by the server page (parse ?tab=) and the client detail view.
export const DETAIL_TABS = [
  "overview",
  "config",
  "connect",
  "logs",
  "security",
] as const
export type DetailTab = (typeof DETAIL_TABS)[number]

export function parseDetailTab(v: unknown): DetailTab {
  return typeof v === "string" && (DETAIL_TABS as readonly string[]).includes(v)
    ? (v as DetailTab)
    : "overview"
}
