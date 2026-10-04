// Role-based access control statements for Better Auth's admin plugin.
import { createAccessControl } from "better-auth/plugins/access"
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access"

export const statement = {
  ...defaultStatements,
  connection: ["read", "create", "update", "delete", "read_all"],
  mcp: ["read", "create", "update", "delete", "read_all"],
  log: ["read", "read_all", "export"],
  setting: ["read", "update"],
} as const

export const ac = createAccessControl(statement)

export const adminRole = ac.newRole({
  ...adminAc.statements,
  connection: ["read", "create", "update", "delete", "read_all"],
  mcp: ["read", "create", "update", "delete", "read_all"],
  log: ["read", "read_all", "export"],
  setting: ["read", "update"],
})

/** Staff: only their own connections / MCPs / MCP logs. No user management, no settings. */
export const staffRole = ac.newRole({
  connection: ["read", "create", "update", "delete"],
  mcp: ["read", "create", "update", "delete"],
  log: ["read", "export"],
})

export const ROLES = ["admin", "staff"] as const
export type AppRole = (typeof ROLES)[number]
