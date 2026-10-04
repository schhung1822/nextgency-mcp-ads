// Entry used only by `pnpm auth:generate` (Better Auth CLI needs an exported `auth` instance).
import { getAuth } from "./auth"

export const auth = getAuth()
