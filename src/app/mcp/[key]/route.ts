// Public MCP endpoint https://<domain>/mcp/<key>. Thin wrapper: all logic lives in src/server/mcp/serve.ts.
import { serveMcp } from "@/server/mcp/serve"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ key: string }> }

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { key } = await ctx.params
  return serveMcp(req, key)
}

export const GET = handle
export const POST = handle
export const DELETE = handle
