// Central adapter wiring. Import `ensureProvidersRegistered()` (or `allProviders`) from server code
// that needs real platform adapters (services, MCP, worker). Tests may register fakes first.
// Only the platforms of RELEASED_PLATFORMS (src/lib/platforms.ts) ship an adapter.
import { metaProvider } from "./meta"
import { openaiAdsProvider } from "./openai-ads"
import { hasProvider, registerProvider } from "./registry"
import type { AdsProvider, Platform } from "./types"

export const allProviders = {
  meta: metaProvider,
  openai_ads: openaiAdsProvider,
} as unknown as Partial<Record<Platform, AdsProvider>>

export function ensureProvidersRegistered(): void {
  for (const p of Object.values(allProviders)) if (p && !hasProvider(p.platform)) registerProvider(p)
}

export { getProvider } from "./registry"
