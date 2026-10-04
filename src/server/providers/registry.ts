// Maps platform → adapter. Adapters register themselves here (orchestrator wires imports on merge).
import { ProviderError } from "./errors"
import type { AdsProvider, Platform } from "./types"

const registry = new Map<Platform, AdsProvider<unknown>>()

export function registerProvider(p: AdsProvider<unknown>) {
  registry.set(p.platform, p)
}

export function getProvider<C = unknown>(platform: Platform): AdsProvider<C> {
  const p = registry.get(platform)
  if (!p) {
    throw new ProviderError({
      platform,
      code: "unsupported",
      message: `No provider registered for ${platform}`,
      userMessageVi: "Nền tảng này chưa được hỗ trợ.",
    })
  }
  return p as AdsProvider<C>
}

export function hasProvider(platform: Platform) {
  return registry.has(platform)
}
