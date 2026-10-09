// telegram_send_message attachments (14-telegram-notifications.md §10.2) without DB / network: input schema
// (ChatGPT file object), source rules, ChatGPT dedupe key, logged args, time budget and error mapping.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { notifications as nm } from "../../../../lib/i18n/vi/notifications"
import { TelegramMediaError } from "../../../notifications/media"
import { McpToolError } from "../../errors"
import {
  attachmentChangeLabel,
  attachmentInputShape,
  attachmentLogArgs,
  chatgptDedupeKey,
  downloadBudgetMs,
  MEDIA_CALL_BUDGET_MS,
  mediaToolError,
  planAttachment,
  sendFailureError,
  uploadBudgetMs,
} from "./attachment"
import { SEND_DESCRIPTION, SEND_META } from "./send-message"

const MCP = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000"

const schema = z.object({
  text: z.string().optional(),
  ...attachmentInputShape,
})

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof McpToolError ? e.code : "other"
  }
}

describe("telegram_send_message attachment input", () => {
  it("declares the ChatGPT file object with all 4 properties, 2 required, nothing else (openai/fileParams)", () => {
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    }) as {
      properties: Record<
        string,
        {
          type?: string
          properties?: Record<string, unknown>
          required?: string[]
          additionalProperties?: unknown
        }
      >
    }
    const file = json.properties.file!
    expect(file.type).toBe("object")
    expect(Object.keys(file.properties ?? {}).sort()).toEqual([
      "download_url",
      "file_id",
      "file_name",
      "mime_type",
    ])
    expect([...(file.required ?? [])].sort()).toEqual([
      "download_url",
      "file_id",
    ])
    expect(file.additionalProperties).toBe(false)
    expect(SEND_META).toEqual({ "openai/fileParams": ["file"] })
  })

  it("lets the ChatGPT-mobile string through the schema so the handler can explain it", () => {
    const parsed = schema.parse({ file: "chat_upload://image_0" })
    expect(parsed.file).toEqual({
      download_url: "chat_upload://image_0",
      file_id: "",
    })
    expect(codeOf(() => planAttachment(parsed))).toBe(
      "chatgpt_file_unavailable"
    )
    // an extra property in the object form is refused by the schema (additionalProperties: false)
    expect(
      schema.safeParse({
        file: { download_url: "https://x.vn/a", file_id: "f", other: 1 },
      }).success
    ).toBe(false)
  })

  it("tool description: starts with Dùng khi, ≤ 1500 characters, names the 3 sources, the limits and the generated-image caveat", () => {
    expect(SEND_DESCRIPTION.startsWith("Dùng khi")).toBe(true)
    expect(SEND_DESCRIPTION.length).toBeLessThanOrEqual(1500)
    for (const s of [
      "file_url",
      "file_content",
      "file =",
      "10 MB",
      "50 MB",
      "800 ký tự",
      "tự tạo",
    ])
      expect(SEND_DESCRIPTION).toContain(s)
  })
})

describe("planAttachment", () => {
  it("text only → null (sent as before); text is required without a file", () => {
    expect(planAttachment({ text: "xin chào" })).toBeNull()
    expect(codeOf(() => planAttachment({}))).toBe("text_required")
    expect(codeOf(() => planAttachment({ text: "   " }))).toBe("text_required")
    expect(
      codeOf(() => planAttachment({ text: "a", file_name: "x.csv" }))
    ).toBe("attachment_missing")
  })

  it("exactly one source", () => {
    expect(
      codeOf(() =>
        planAttachment({
          file_url: "https://x.vn/a.png",
          file_content: "a",
          file_name: "a.csv",
        })
      )
    ).toBe("attachment_conflict")
    expect(
      codeOf(() =>
        planAttachment({
          file_url: "https://x.vn/a.png",
          file: { download_url: "https://y.vn/b", file_id: "f" },
        })
      )
    ).toBe("attachment_conflict")
  })

  it("with a file the text is an optional caption of at most 800 characters", () => {
    expect(planAttachment({ file_url: "https://x.vn/a.png" })?.source).toEqual({
      type: "url",
      url: "https://x.vn/a.png",
    })
    expect(
      codeOf(() =>
        planAttachment({
          file_url: "https://x.vn/a.png",
          text: "x".repeat(800),
        })
      )
    ).toBeNull()
    expect(
      codeOf(() =>
        planAttachment({
          file_url: "https://x.vn/a.png",
          text: "x".repeat(801),
        })
      )
    ).toBe("caption_too_long")
  })

  it("file_content needs file_name; file_name overrides the URL / ChatGPT name; send_as defaults to auto", () => {
    expect(codeOf(() => planAttachment({ file_content: "a,b" }))).toBe(
      "file_name_required"
    )
    expect(planAttachment({ file_content: "a,b", file_name: "r.csv" })).toEqual(
      {
        source: { type: "text", content: "a,b", fileName: "r.csv" },
        sendAs: "auto",
        dedupeKey: null,
      }
    )
    expect(
      planAttachment({
        file_url: "https://x.vn/a.png",
        file_name: "anh.png",
        send_as: "document",
      })
    ).toMatchObject({
      source: { type: "url", fileName: "anh.png" },
      sendAs: "document",
    })
    const now = Date.UTC(2026, 9, 9, 10, 0, 30)
    const plan = planAttachment(
      {
        file: {
          download_url: "https://files.oaiusercontent.com/x?sig=1",
          file_id: "file_1",
          mime_type: "image/png",
          file_name: "a.png",
        },
      },
      { mcpId: MCP, now }
    )
    expect(plan).toEqual({
      source: {
        type: "chatgpt",
        downloadUrl: "https://files.oaiusercontent.com/x?sig=1",
        fileId: "file_1",
        mimeType: "image/png",
        fileName: "a.png",
      },
      sendAs: "auto",
      dedupeKey: chatgptDedupeKey(MCP, "file_1", now),
    })
  })

  it("a ChatGPT file whose download_url is not https is refused with a clear error", () => {
    expect(
      codeOf(() =>
        planAttachment({
          file: { download_url: "http://x.vn/a", file_id: "f" },
        })
      )
    ).toBe("chatgpt_file_unavailable")
    expect(
      codeOf(() =>
        planAttachment({
          file: { download_url: "https://x.vn/a", file_id: " " },
        })
      )
    ).toBe("chatgpt_file_unavailable")
  })
})

describe("chatgptDedupeKey", () => {
  it("same MCP + file_id in the same 2-minute bucket → same key; next bucket / other file / other MCP → another key", () => {
    const t = Date.UTC(2026, 9, 9, 10, 0, 0)
    expect(chatgptDedupeKey(MCP, "file_1", t)).toBe(
      chatgptDedupeKey(MCP, "file_1", t + 119_000)
    )
    expect(chatgptDedupeKey(MCP, "file_1", t)).not.toBe(
      chatgptDedupeKey(MCP, "file_1", t + 120_000)
    )
    expect(chatgptDedupeKey(MCP, "file_1", t)).not.toBe(
      chatgptDedupeKey(MCP, "file_2", t)
    )
    expect(chatgptDedupeKey(MCP, "file_1", t)).not.toBe(
      chatgptDedupeKey("0199aaaa-bbbb-7ccc-8ddd-000000000001", "file_1", t)
    )
  })

  it("format cgf:<mcpId>:<sha256(file_id) first 32 hex>:<bucket> - the raw file id never appears", () => {
    const t = Date.UTC(2026, 9, 9, 10, 0, 0)
    const fileId = `file_${"x".repeat(300)}`
    const key = chatgptDedupeKey(MCP, fileId, t)
    const h = createHash("sha256").update(fileId).digest("hex").slice(0, 32)
    expect(key).toBe(`cgf:${MCP}:${h}:${Math.floor(t / 120_000)}`)
    expect(key).not.toContain("file_")
    expect(key.length).toBeLessThan(100)
  })
})

describe("attachmentLogArgs", () => {
  it("never logs the signed download_url, a URL query string or the file body", () => {
    const out = attachmentLogArgs({
      text: "hi",
      file_url: "https://cdn.x.vn/a.png?X-Amz-Signature=SECRET#frag",
      file: {
        download_url: "https://files.oaiusercontent.com/f?sig=TOPSECRET",
        file_id: "file_1",
        file_name: "a.pdf",
      },
      file_content: "ma,so\n1,2",
    })
    const json = JSON.stringify(out)
    expect(json).not.toContain("SECRET")
    expect(json).not.toContain("oaiusercontent")
    expect(out.file_url).toBe("https://cdn.x.vn/a.png?[redacted]")
    expect(out.file).toEqual({
      download_url: "[redacted]",
      file_id: "file_1",
      file_name: "a.pdf",
    })
    expect(out.file_content).toBe("9 ký tự")
    expect(out.text).toBe("hi")
  })
})

describe("time budget (ChatGPT cuts a call at 60 s)", () => {
  it("download ≤ 25 s and leaves the upload its share; upload ≤ 30 s; slot wait + download + upload ≤ 50 s", () => {
    const start = 1_000_000
    const deadline = start + MEDIA_CALL_BUDGET_MS
    // slot taken after the maximum 5 s wait
    const dl = downloadBudgetMs(deadline, start + 5_000)
    expect(dl).toBe(25_000)
    const up = uploadBudgetMs(deadline, start + 5_000 + dl)
    expect(up).toBe(20_000)
    expect(5_000 + dl + up).toBeLessThanOrEqual(50_000)
    expect(uploadBudgetMs(deadline, start)).toBe(30_000)
    expect(downloadBudgetMs(deadline, deadline)).toBe(1_000)
  })
})

describe("error mapping", () => {
  it("TelegramMediaError → tool error with its Vietnamese message + hint (busy = rate_limited)", () => {
    const e = mediaToolError(
      new TelegramMediaError("telegram_file_type_not_allowed")
    )
    expect(e.code).toBe("telegram_file_type_not_allowed")
    expect(e.messageVi.length).toBeGreaterThan(0)
    expect(e.hint).toBeTruthy()
    expect(
      mediaToolError(new TelegramMediaError("telegram_busy")).logStatus
    ).toBe("rate_limited")
  })

  it("send outcomes: historical codes for text, file-specific codes for media", () => {
    const base = {
      ok: false as const,
      deliveryId: "d",
      error: "lỗi",
      channelStatus: "active" as const,
    }
    expect(
      sendFailureError({ ...base, kind: "channel_unavailable" }).code
    ).toBe("channel_unavailable")
    expect(sendFailureError({ ...base, kind: "forbidden" }).code).toBe(
      "telegram_send_failed"
    )
    expect(sendFailureError({ ...base, kind: "network" }).code).toBe(
      "telegram_send_failed"
    )
    // text-only: a Telegram timeout keeps the historical code
    expect(sendFailureError({ ...base, kind: "timeout" }).code).toBe(
      "telegram_send_failed"
    )
    const media = { media: true }
    expect(
      sendFailureError(
        { ...base, kind: "network" },
        { ...media, deadlinePassed: true }
      ).code
    ).toBe("telegram_file_timeout")
    expect(sendFailureError({ ...base, kind: "network" }, media).code).toBe(
      "telegram_send_failed"
    )
    expect(sendFailureError({ ...base, kind: "timeout" }, media).code).toBe(
      "telegram_file_timeout"
    )
    expect(
      sendFailureError({ ...base, kind: "file_too_large" }, media).code
    ).toBe("telegram_file_too_large")
    expect(
      sendFailureError({ ...base, kind: "duplicate", duplicate: true }).code
    ).toBe("telegram_duplicate")
  })

  it("an upload cut by the deadline is reported as uncertain (may have been posted - check before resending)", () => {
    const base = {
      ok: false as const,
      deliveryId: "d",
      error: "lỗi",
      channelStatus: "active" as const,
    }
    for (const e of [
      sendFailureError({ ...base, kind: "timeout" }, { media: true }),
      sendFailureError(
        { ...base, kind: "network" },
        { media: true, deadlinePassed: true }
      ),
    ]) {
      expect(e.code).toBe("telegram_file_timeout")
      expect(e.messageVi).toBe(nm.media.uploadUncertain)
      expect(e.messageVi).toContain("có thể đã được gửi")
      expect(e.hint).toBe(nm.media.uploadUncertainHint)
    }
  })

  it("a duplicate still pending is never described as sent", () => {
    const e = sendFailureError({
      ok: false,
      deliveryId: "d",
      error: nm.errors.duplicateDelivery,
      kind: "duplicate",
      channelStatus: null,
      duplicate: true,
    })
    expect(e.code).toBe("telegram_duplicate")
    for (const s of [e.messageVi, e.hint ?? ""]) {
      expect(s).not.toMatch(/đã (được )?gửi/)
      expect(s).not.toContain("đã xử lý")
    }
  })

  it("changes label: kind, name, size, caption length", () => {
    expect(
      attachmentChangeLabel(
        { kind: "photo", fileName: "a.png", sizeBytes: 2048 },
        12
      )
    ).toBe("Ảnh a.png (2 KB) + 12 ký tự")
  })
})
