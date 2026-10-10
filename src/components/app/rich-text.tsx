import * as React from "react"

/**
 * Tiny inline markup for help strings in src/lib/i18n/vi/*: `**bold**` → <strong> (UI labels to click) and
 * `` `code` `` → <code> (tool names, file names). Plain text otherwise - no HTML is ever injected.
 */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
          return (
            <strong key={i} className="font-medium text-foreground">
              {p.slice(2, -2)}
            </strong>
          )
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2)
          return (
            <code
              key={i}
              className="rounded-md bg-background box-decoration-clone px-1 py-px font-mono text-[12px] [overflow-wrap:anywhere] text-foreground ring-1 ring-foreground/10"
            >
              {p.slice(1, -1)}
            </code>
          )
        return <React.Fragment key={i}>{p}</React.Fragment>
      })}
    </>
  )
}

/** Strips the markup (aria labels, keys, plain-text copies). */
export function plainText(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1")
}
