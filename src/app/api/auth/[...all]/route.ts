// Better Auth HTTP endpoints (/api/auth/*): sign-in, 2FA verification, sign-out… (rate limited by Better Auth).
import { toNextJsHandler } from "better-auth/next-js"

import { getAuth } from "@/server/auth/auth"

export const dynamic = "force-dynamic"

// Resolve the auth instance per request (lazy) so `next build` does not need DATABASE_URL.
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler((request: Request) => getAuth().handler(request))
