// Next.js instrumentation (runs once per server instance). Node runtime only: flush the
// mcp_call_logs batch writer on SIGTERM/SIGINT so queued log rows are not lost on shutdown.
// Keep the documented `=== "nodejs"` + dynamic import shape so the bundler drops it from Edge builds.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail fast in production on unsafe configuration (http BETTER_AUTH_URL, short SETUP_TOKEN, weak secrets…)
    // and on an unusable key ring / MCP key pepper (otherwise the first decrypt or MCP request would fail).
    if (process.env.NODE_ENV === "production") {
      const { env } = await import("./server/env")
      env()
      const { assertKeyRing } = await import("./server/crypto/secret-box")
      assertKeyRing()
      const { assertMcpKeyPepper } = await import("./server/crypto/mcp-key")
      assertMcpKeyPepper()
    }
    const { registerMcpLogShutdownHooks } = await import("./server/audit/mcp-log-writer")
    registerMcpLogShutdownHooks()
  }
}
