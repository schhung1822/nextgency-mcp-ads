// "Giảm hiệu ứng trong suốt" preference: localStorage + html[data-transparency="reduced"].
export const TRANSPARENCY_STORAGE_KEY = "ads-mcp:transparency"
export const TRANSPARENCY_ATTR = "data-transparency"
const CHANGE_EVENT = "ads-mcp:transparency-change"

/** Inline script (runs before paint) - keep tiny and dependency-free. */
export const TRANSPARENCY_INIT_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(
  TRANSPARENCY_STORAGE_KEY
)})==="reduced")document.documentElement.setAttribute(${JSON.stringify(TRANSPARENCY_ATTR)},"reduced")}catch(e){}})()`

export function readReducedTransparency(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.getAttribute(TRANSPARENCY_ATTR) === "reduced"
}

/** Applies the stored preference to <html> (for when the inline script is not present). */
export function applyStoredTransparency(): void {
  try {
    const reduced = localStorage.getItem(TRANSPARENCY_STORAGE_KEY) === "reduced"
    if (reduced !== readReducedTransparency()) setReducedTransparency(reduced)
  } catch {
    /* storage unavailable */
  }
}

export function setReducedTransparency(reduced: boolean): void {
  const root = document.documentElement
  if (reduced) root.setAttribute(TRANSPARENCY_ATTR, "reduced")
  else root.removeAttribute(TRANSPARENCY_ATTR)
  try {
    if (reduced) localStorage.setItem(TRANSPARENCY_STORAGE_KEY, "reduced")
    else localStorage.removeItem(TRANSPARENCY_STORAGE_KEY)
  } catch {
    /* storage unavailable - attribute still applies for this page view */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeTransparency(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === TRANSPARENCY_STORAGE_KEY) {
      const reduced = e.newValue === "reduced"
      if (reduced)
        document.documentElement.setAttribute(TRANSPARENCY_ATTR, "reduced")
      else document.documentElement.removeAttribute(TRANSPARENCY_ATTR)
      onChange()
    }
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}
