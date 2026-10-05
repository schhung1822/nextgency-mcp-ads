// SDK v2 handler: one fresh McpServer per HTTP request, built from the grant passed in authInfo.
// Serves 2026-07-28 (modern, per-request envelope) traffic and, by default (legacy: 'stateless'),
// 2025-era `initialize` clients statelessly.
import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server"
import { safeErrorForLog } from "../audit/safe-error"
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, SERVER_INSTRUCTIONS } from "./instructions"
import { ensureProvidersRegistered } from "./providers"
import { registerAllowedTools } from "./registry"
import { extraFromAuthInfo } from "./request-state"

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024

export function buildMcpServer(ctx: Parameters<typeof extraFromAuthInfo>[0]): McpServer {
  const { grant, req } = extraFromAuthInfo(ctx)
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, title: "Ads MCP by noti.vn" },
    { instructions: SERVER_INSTRUCTIONS }
  )
  registerAllowedTools(server, { grant, req })
  return server
}

const g = globalThis as unknown as { __adsMcpHandler?: McpHttpHandler }

export function mcpHandler(): McpHttpHandler {
  ensureProvidersRegistered()
  g.__adsMcpHandler ??=createMcpHandler(({ authInfo }) => buildMcpServer(authInfo), {
    responseMode: "json",
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: (err) => {
      // reporting only; never includes the key (URL path is not part of SDK errors); redacted, params stripped
      console.warn("[mcp] sdk:", safeErrorForLog(err))
    },
  })
  return g.__adsMcpHandler
}
