// Client-side shapes for the /users page (mirror src/server/services/users.ts read models; no secrets).
import type { ActionResult } from "@/lib/action-result"

export type Role = "admin" | "staff"

export interface UserRow {
  id: string
  name: string
  email: string
  role: Role
  twoFactorEnabled: boolean
  banned: boolean
  mustChangePassword: boolean
  createdAt: string
  lastLoginAt: string | null
}

export interface SessionRow {
  id: string
  device: string
  ip: string | null
  createdAt: string
  lastActiveAt: string
  expiresAt: string
  current: boolean
}

/** Server actions passed down from the page (server component) - client code never imports src/server. */
export interface UserActions {
  create: (input: unknown) => Promise<ActionResult<{ userId: string }>>
  changeRole: (input: unknown) => Promise<ActionResult>
  resetPassword: (input: unknown) => Promise<ActionResult>
  reset2fa: (input: unknown) => Promise<ActionResult>
  setBanned: (input: unknown) => Promise<ActionResult>
  listSessions: (input: unknown) => Promise<ActionResult<SessionRow[]>>
  revokeSessions: (input: unknown) => Promise<ActionResult<{ count: number }>>
  remove: (input: unknown) => Promise<ActionResult>
}
