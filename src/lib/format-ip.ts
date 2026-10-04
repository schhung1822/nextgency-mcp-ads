// Display helper for session/activity IP addresses (safe for client and server).

/**
 * Human-friendly IP: IPv4 stays as is; a fully expanded IPv6 ("2001:0db8:0000:…:0001") is shortened
 * ("2001:db8::1"); an all-zero address (what a loopback/unknown peer is stored as) → null so the UI can say
 * "Không rõ IP". Anything unparseable is returned unchanged.
 */
export function formatIp(ip: string | null | undefined): string | null {
  const raw = (ip ?? "").trim()
  if (!raw) return null
  if (!raw.includes(":")) return raw
  if (/^[0:]+$/.test(raw)) return null
  // IPv4-mapped / IPv4-embedded forms ("::ffff:1.2.3.4") are already short
  if (raw.includes(".")) return raw
  if (raw.includes("::")) return raw.toLowerCase()
  const groups = raw.split(":")
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return raw
  const parts = groups.map((g) => g.replace(/^0+(?=.)/, "").toLowerCase())
  // longest run (≥ 2) of "0" groups → "::"
  let bestStart = -1
  let bestLen = 0
  for (let i = 0; i < parts.length; ) {
    if (parts[i] !== "0") {
      i++
      continue
    }
    let j = i
    while (j < parts.length && parts[j] === "0") j++
    if (j - i > bestLen) {
      bestStart = i
      bestLen = j - i
    }
    i = j
  }
  if (bestLen < 2) return parts.join(":")
  const head = parts.slice(0, bestStart).join(":")
  const tail = parts.slice(bestStart + bestLen).join(":")
  return `${head}::${tail}`
}
