// apify_abort_run (16-apify.md §7): stop a run started by THIS MCP, with the token that started it. Stopping spends
// nothing, so it does not count in the write limit; a run already finished is answered as is (no Apify call).
import { z } from "zod"

import { abortRun } from "@/server/apify/actors"
import { runPatch, updateRunStatus } from "@/server/apify/pool"

import { registerToolSpec, type ToolContext } from "../../tool"
import {
  ABORT_ANNOTATIONS,
  apifyCall,
  assertApifyEnabled,
  isFinished,
  pinnedContext,
  runIdSchema,
  runOfMcp,
  runOutput,
  runOutputShape,
  usd,
} from "./shared"

export const NAME = "apify_abort_run"

export function register(
  server: Parameters<typeof registerToolSpec>[0],
  tctx: ToolContext
) {
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Dừng lần chạy Apify",
    description:
      "Dùng khi người dùng muốn dừng một lần chạy Apify của MCP này đang chạy (vd chạy nhầm, quá lâu, không cần nữa) để không tốn thêm tiền: dừng run_id do apify_run_task / apify_run_actor trả về. Dữ liệu đã thu được vẫn đọc được bằng apify_get_results; chi phí đã phát sinh không được hoàn. Lần chạy đã xong thì không làm gì.",
    kind: "write",
    annotations: ABORT_ANNOTATIONS,
    input: z.object({ run_id: runIdSchema }),
    output: z.object({ ...runOutputShape, aborted: z.boolean() }),
    async handler(args, env) {
      const { grant } = env
      assertApifyEnabled(grant)
      const rec = await runOfMcp(grant, args.run_id)
      env.log.setTarget({ objectIds: [rec.runId] })
      if (isFinished(rec.status)) {
        const out = runOutput(rec, null, null, [])
        return {
          structured: { ...out, aborted: false },
          summary: `Lần chạy Apify ${rec.runId} đã kết thúc trước đó (${rec.status}) - không cần dừng.`,
        }
      }
      const ctx = await pinnedContext(rec.tokenId, env.signal)
      const run = await apifyCall(() => abortRun(ctx, rec.runId), {
        notFound: "run",
      })
      await updateRunStatus(rec.id, runPatch(run))
      env.log.setChanges([
        {
          objectId: rec.runId,
          objectName: rec.taskKey ?? rec.actorId,
          field: "apify_run_status",
          before: rec.status,
          after: run.status,
        },
      ])
      const out = runOutput(rec, run, null, [])
      return {
        structured: { ...out, aborted: true },
        summary: `Đã dừng lần chạy Apify ${rec.runId} (${run.status})${out.usage_usd !== null ? `, chi phí đến lúc dừng ${usd(out.usage_usd)}` : ""}. Dữ liệu đã thu được vẫn đọc được bằng apify_get_results.`,
      }
    },
  })
}
