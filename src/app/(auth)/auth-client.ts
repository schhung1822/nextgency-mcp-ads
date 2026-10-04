"use client"
// Better Auth browser client for the public auth screens. Sign-in and 2FA verification go through
// /api/auth/* over HTTP so Better Auth's per-IP rate limits apply (server-side auth.api calls skip them).
import { twoFactorClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
})
