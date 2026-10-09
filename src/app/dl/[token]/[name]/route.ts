// Public temporary video link https://<domain>/dl/<token>/<file name> (15-google-drive-media.md §8): ad platforms
// download Drive videos through it. Thin wrapper: all logic lives in src/server/drive/relay-serve.ts.
// Not behind the session proxy (src/proxy.ts matcher excludes dl/); CSP / Referrer-Policy for /dl/* come from
// next.config.ts (a route handler cannot override headers set there).
import { serveRelay } from "@/server/drive/relay-serve"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ token: string; name: string }> }

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { token, name } = await ctx.params
  return serveRelay(req, token, name)
}

export const GET = handle
export const HEAD = handle
