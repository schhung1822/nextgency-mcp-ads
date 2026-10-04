// Server-only context for user creation through Better Auth (`auth.api.createUser`).
// Framework-free (loaded by the Better Auth hooks / CLI config) - no `next/*` imports.
//
// - L4: a headerless `createUser` (no session to check) is only accepted when the caller explicitly runs
//   inside `runWithUserCreateContext({ kind: "setup" | "dev-seed" })` (or the user table is empty).
//   This flag cannot be set over HTTP: it lives in an AsyncLocalStorage of the calling server code.
// - L7: `databaseHooks.user.create.before` (auth.ts) reads `mustChangePassword` / `createdById` from it,
//   so the user row is INSERTED with the right flags - there is no window where a temp password exists
//   without `must_change_password = true`. Without a context the hook fails safe (mustChangePassword: true).
import { AsyncLocalStorage } from "node:async_hooks"

export type UserCreateKind = "setup" | "admin" | "dev-seed"

export interface UserCreateContext {
  kind: UserCreateKind
  /** acting admin (kind "admin") */
  createdById?: string | null
  mustChangePassword: boolean
}

// One instance per process even if the module is bundled more than once (Next route/action bundles).
const g = globalThis as unknown as { __adsMcpUserCreateAls?: AsyncLocalStorage<UserCreateContext> }
const als = (g.__adsMcpUserCreateAls ??= new AsyncLocalStorage<UserCreateContext>())

export function runWithUserCreateContext<T>(ctx: UserCreateContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn)
}

export function currentUserCreateContext(): UserCreateContext | null {
  return als.getStore() ?? null
}

/** Kinds allowed to call `createUser` without any request context (no session to authorize). */
export function isTrustedHeaderlessCreate(ctx: UserCreateContext | null): boolean {
  return ctx?.kind === "setup" || ctx?.kind === "dev-seed"
}

/** Fields forced onto every new user row (databaseHooks.user.create.before). */
export function userCreateOverrides(ctx: UserCreateContext | null): { mustChangePassword: boolean; createdById: string | null } {
  if (!ctx) return { mustChangePassword: true, createdById: null }
  return { mustChangePassword: ctx.mustChangePassword, createdById: ctx.createdById ?? null }
}
