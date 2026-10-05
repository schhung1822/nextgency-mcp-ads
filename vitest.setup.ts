// Deterministic test secrets (never used outside tests).
process.env.ENCRYPTION_KEYS ??= "1:" + Buffer.alloc(32, 7).toString("base64")
process.env.MCP_KEY_PEPPER ??= Buffer.alloc(32, 9).toString("base64")
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0000"
process.env.TZ = "UTC"
// no system notices in the web layout unless a test opts in (the dev DB may hold real ones)
process.env.SYSTEM_NOTICES_URL ??= ""
// log tables are append-only (DB trigger, migration 0005); tests clean up their own rows -> allow it for every
// pg connection of the test process (node-postgres reads PGOPTIONS). Production never sets this GUC.
process.env.PGOPTIONS ??= "-c ads_mcp.log_mutation=allow"
