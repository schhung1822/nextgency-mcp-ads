import { InlineScript } from "./inline-script"
import { TRANSPARENCY_INIT_SCRIPT } from "./transparency"

/**
 * Applies the "Giảm hiệu ứng trong suốt" preference before first paint.
 * Render it once inside `<head>` of the root layout (html already has suppressHydrationWarning).
 * Executable only from the server HTML (see InlineScript); in the browser `useTransparencySync()`
 * re-applies the preference (dev Strict Mode remount resets <html> attributes).
 */
export function TransparencyScript({ nonce }: { nonce?: string }) {
  return <InlineScript html={TRANSPARENCY_INIT_SCRIPT} nonce={nonce} />
}
