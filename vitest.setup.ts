// Deterministic test secrets (never used outside tests).
process.env.ENCRYPTION_KEYS ??= "1:" + Buffer.alloc(32, 7).toString("base64")
process.env.MCP_KEY_PEPPER ??= Buffer.alloc(32, 9).toString("base64")
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0000"
process.env.TZ = "UTC"
