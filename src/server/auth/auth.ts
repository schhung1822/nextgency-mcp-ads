// Better Auth core configuration. Schema-affecting options live here (orchestrator owns schema);
// the auth feature (hooks, activity logging, lockout) is wired through ./hooks.ts.
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { nextCookies } from "better-auth/next-js"
import { admin, twoFactor } from "better-auth/plugins"
import { getDb } from "@/server/db/client"
import * as schema from "@/server/db/schema"
import { ADMIN_ENDPOINT_PATHS } from "./guards"
import { auditPlugin, authHooks } from "./hooks"
import { ac, adminRole, staffRole } from "./permissions"
import { currentUserCreateContext, userCreateOverrides } from "./user-create-context"

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000"

function createAuth() {
  return betterAuth({
    appName: "Ads MCP by Nextgency",
    baseURL,
    trustedOrigins: [baseURL],
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    // No browser admin client: every /api/auth/admin/* endpoint answers 404 over HTTP (they would bypass the
    // users-service policy). Server-side auth.api.* calls skip disabledPaths - hooks.ts guards those (and
    // rejects any admin call that still arrives with a Request).
    disabledPaths: ["/sign-up/email", ...ADMIN_ENDPOINT_PATHS],
    user: {
      additionalFields: {
        mustChangePassword: { type: "boolean", defaultValue: false, input: false, required: false },
        createdById: { type: "string", input: false, required: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 30,
      freshAge: 60 * 10,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/two-factor/*": { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // L7: mustChangePassword/createdById are part of the INSERT (no window with an unflagged temp
          // password). Context set by the users service (/setup, admin create); none → fail safe (must change).
          before: async (data) => ({ data: { ...data, ...userCreateOverrides(currentUserCreateContext()) } }),
        },
      },
    },
    hooks: authHooks,
    plugins: [
      twoFactor({
        issuer: "Ads MCP (Nextgency)",
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
        trustDeviceMaxAge: 60 * 60 * 24 * 14,
      }),
      admin({
        ac,
        roles: { admin: adminRole, staff: staffRole },
        defaultRole: "staff",
        adminRoles: ["admin"],
        impersonationSessionDuration: 60 * 30,
      }),
      auditPlugin(), // activity_logs after-hooks: must run after twoFactor's after-hook
      nextCookies(), // must stay last
    ],
  })
}

type Auth = ReturnType<typeof createAuth>
const g = globalThis as unknown as { __adsMcpAuth?: Auth }

/** Lazily created so `next build` does not need DATABASE_URL. */
export function getAuth(): Auth {
  g.__adsMcpAuth ??= createAuth()
  return g.__adsMcpAuth
}

export type Session = Auth["$Infer"]["Session"]
