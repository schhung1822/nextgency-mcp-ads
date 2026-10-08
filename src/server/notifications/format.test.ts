// Telegram message formatting: HTML escaping (untrusted names from ad platforms), truncation, length guard, builders.
import { describe, expect, it } from "vitest"

import {
  buildAiMessage,
  buildConnectionHealthMessage,
  buildMcpWriteMessage,
  buildTestMessage,
  buildUpdateAvailableMessage,
  buildUpdateResultMessage,
  escapeHtml,
  fitMessage,
  MAX_DYNAMIC_TEXT,
  previewOf,
  scrubText,
  TELEGRAM_MAX_MESSAGE,
  truncateText,
} from "./format"

/** tags left after removing the ones our templates may emit */
function foreignTags(html: string): string[] {
  return (html.match(/<\/?[a-z][^>]*>/gi) ?? []).filter(
    (t) => !/^<\/?(b|i|code|blockquote)>$/.test(t)
  )
}

describe("escapeHtml / truncateText", () => {
  it('escape & trước rồi mới < > " (không escape hai lần)', () => {
    expect(escapeHtml(`a & b <script>"x"</script> &amp;`)).toBe(
      "a &amp; b &lt;script&gt;&quot;x&quot;&lt;/script&gt; &amp;amp;"
    )
  })

  it("cắt đúng độ dài, thêm … và không cắt đôi emoji (surrogate pair)", () => {
    expect(truncateText("abcdef", 10)).toBe("abcdef")
    expect(truncateText("abcdef", 4)).toBe("abc…")
    const s = "ab😀cd"
    const cut = truncateText(s, 4)
    expect(cut.endsWith("…")).toBe(true)
    expect(cut).not.toMatch(/[\ud800-\udbff]…$/)
  })
})

describe("builders", () => {
  it("tên đối tượng chứa HTML/thẻ lạ luôn được escape trong tin mcp_write", () => {
    const html = buildMcpWriteMessage({
      mcpName: "Báo cáo <b>hằng ngày</b>",
      platform: "meta",
      accountId: "act_123",
      toolName: "ads_set_status",
      changes: [
        {
          objectId: "1",
          objectName: 'QC <a href="https://evil">A</a>',
          level: "ad",
          field: "status",
          before: "ACTIVE",
          after: "PAUSED",
        },
        {
          objectId: "2",
          objectName: "QC B & C",
          level: "ad",
          field: "status",
          before: "ACTIVE",
          after: "PAUSED",
        },
      ],
      reason: "CPA vượt <200.000 ₫>",
    })
    expect(html).toContain("⏸ <b>AI đã tạm dừng 2 quảng cáo</b>")
    expect(html).toContain(
      "QC &lt;a href=&quot;https://evil&quot;&gt;A&lt;/a&gt; (1): Đang chạy → Tạm dừng"
    )
    expect(html).toContain("QC B &amp; C (2)")
    expect(html).toContain("<code>act_123</code>")
    expect(html).toContain("Lý do: CPA vượt &lt;200.000 ₫&gt;")
    expect(foreignTags(html)).toEqual([])
  })

  it("mcp_write: ngân sách (đơn vị chính + mã tiền), display có sẵn, giới hạn số dòng", () => {
    const changes = Array.from({ length: 40 }, (_, i) => ({
      objectId: String(i),
      objectName: `Nhóm ${i}`,
      level: "ad_group" as const,
      field: "daily_budget",
      before: 100000,
      after: 200000,
      currency: "VND",
    }))
    const html = buildMcpWriteMessage({
      mcpName: "M",
      platform: "meta",
      toolName: "ads_update_budget",
      changes,
    })
    expect(html).toContain("💰 <b>AI đã đổi ngân sách 40 nhóm quảng cáo</b>")
    expect(html).toMatch(/100\.000\s₫ → 200\.000\s₫/)
    expect(html).toContain("… và 25 thay đổi khác")
    const pre = buildMcpWriteMessage({
      mcpName: "M",
      platform: "openai_ads",
      toolName: "openai_ads_update_campaign",
      changes: [
        {
          objectId: "c1",
          field: "budget",
          before: 1,
          after: 2,
          display: { before: "$10.00", after: "$20.00" },
        },
      ],
    })
    expect(pre).toContain("$10.00 → $20.00")
    expect(pre).toContain("OpenAI Ads")
  })

  it("tin AI có tiêu đề cố định và nội dung đã escape (AI không chèn được HTML)", () => {
    const html = buildAiMessage({
      mcpName: "Trợ lý",
      text: "<b>giả mạo</b> & <i>x</i>",
    })
    expect(html.startsWith("<b>🤖 Tin từ AI · MCP Trợ lý</b>\n\n")).toBe(true)
    expect(html).toContain(
      "&lt;b&gt;giả mạo&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;"
    )
    const long = buildAiMessage({ mcpName: "M", text: "x".repeat(10_000) })
    expect(long.length).toBeLessThan(MAX_DYNAMIC_TEXT + 100)
    expect(long.endsWith("…")).toBe(true)
  })

  it("tin kết nối, cập nhật, tin thử: đúng tiêu đề và escape", () => {
    const exp = buildConnectionHealthMessage({
      event: "connection_expiring",
      connectionName: "Meta <chính>",
      platform: "meta",
      ownerEmail: "a@b.vn",
      statusMessage: "Token sẽ hết hạn sau 3 ngày",
      tokenExpiresAt: new Date("2026-10-10T00:00:00Z"),
    })
    expect(exp).toContain("⏳ <b>Kết nối quảng cáo sắp hết hạn</b>")
    expect(exp).toContain("<code>Meta &lt;chính&gt;</code> · Meta")
    expect(exp).toContain(
      "<blockquote>Token sẽ hết hạn sau 3 ngày</blockquote>"
    )
    expect(
      buildConnectionHealthMessage({
        event: "connection_invalid",
        connectionName: "x",
        platform: "meta",
      })
    ).toContain("⛔")
    expect(
      buildConnectionHealthMessage({
        event: "connection_recovered",
        connectionName: "x",
        platform: "meta",
      })
    ).toContain("✅")
    expect(
      buildUpdateAvailableMessage({
        version: "1.2.0",
        currentVersion: "1.1.0",
        notes: "<script>",
      })
    ).toContain("&lt;script&gt;")
    expect(
      buildUpdateResultMessage({
        status: "rolled_back",
        targetVersion: "1.2.0",
        message: "lỗi",
      })
    ).toContain("↩️")
    expect(
      buildUpdateResultMessage({ status: "failed", targetVersion: "1.2.0" })
    ).toContain("❌")
    expect(
      buildTestMessage({ channelName: "Nhóm <QC>", actorEmail: "a@b.vn" })
    ).toContain("Nhóm &lt;QC&gt;")
  })

  it("token trong statusMessage bị redact", () => {
    const html = buildConnectionHealthMessage({
      event: "connection_invalid",
      connectionName: "x",
      platform: "meta",
      statusMessage: "lỗi với EAABwzLixnjYBO1234567890abcdefghij",
    })
    expect(html).not.toContain("EAABwzLixnjYBO1234567890")
  })
})

describe("secrets never leave through Telegram (redact + URL queries, before truncate/escape)", () => {
  const TG = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
  const META = "EAABwzLixnjYBO1234567890abcdefghij"
  const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz123456"
  const SIGNED =
    "https://cdn.example.com/img/a.jpg?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIA123"

  it("mcp_write: tên đối tượng, before/after, display, field, lý do, tên MCP đều được redact", () => {
    const html = buildMcpWriteMessage({
      mcpName: `MCP ${OPENAI}`,
      platform: "meta",
      accountId: "act_1",
      toolName: "ads_update_object",
      changes: [
        {
          objectId: "1",
          objectName: `QC ${META}`,
          field: "image_url",
          before: SIGNED,
          after: `gs://bucket/b.png?token=${TG}`,
        },
        {
          objectId: "2",
          objectName: "QC 2",
          field: "link",
          before: { url: SIGNED, note: TG },
          after: "https://shop.vn/p?utm_source=fb&code=SECRETCODE",
        },
        {
          objectId: "3",
          objectName: "QC 3",
          field: `x ${META}`,
          before: 1,
          after: 2,
          display: { before: `a ${OPENAI}`, after: `b ${SIGNED}` },
        },
      ],
      reason: `vì ${TG} và ${SIGNED}`,
    })
    for (const secret of [
      TG.slice(10),
      META.slice(3, 20),
      OPENAI.slice(8),
      "deadbeefcafe",
      "AKIA123",
      "SECRETCODE",
    ]) {
      expect(html).not.toContain(secret)
    }
    // the URL stays readable: scheme + host + path
    expect(html).toContain("https://cdn.example.com/img/a.jpg?[redacted]")
    expect(html).toContain("gs://bucket/b.png?[redacted]")
    expect(foreignTags(html)).toEqual([])
  })

  it("scrubText: URL trong văn bản mất query/fragment, token bị che; văn bản thường giữ nguyên", () => {
    expect(scrubText("xem https://a.vn/x?sig=1#f rồi báo")).toBe(
      "xem https://a.vn/x?[redacted] rồi báo"
    )
    expect(scrubText(`token ${TG}`)).not.toContain(TG.slice(10))
    expect(scrubText("Chiến dịch 12:30 act_123")).toBe(
      "Chiến dịch 12:30 act_123"
    )
    expect(scrubText(null)).toBe("")
  })

  it("tin AI: nội dung và tên MCP được redact; link UTM giữ nguyên", () => {
    const html = buildAiMessage({
      mcpName: `MCP ${META}`,
      text: `Báo cáo: ${TG} ${OPENAI} https://shop.vn/p?utm_source=fb`,
    })
    expect(html).not.toContain(TG.slice(10))
    expect(html).not.toContain(OPENAI.slice(8))
    expect(html).not.toContain(META.slice(3, 20))
    expect(html).toContain("https://shop.vn/p?utm_source=fb")
  })
})

describe("fitMessage / previewOf", () => {
  it("tin quá 4096 ký tự → chuyển plain text đã escape, không vượt giới hạn, không còn thẻ", () => {
    const html = `<b>tiêu đề</b>\n${"&amp;".repeat(2000)}`
    const out = fitMessage(html)
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE)
    expect(out).not.toContain("<b>")
    expect(fitMessage("<b>ngắn</b>")).toBe("<b>ngắn</b>")
  })

  it("preview là text thuần ≤ 300 ký tự và đã redact", () => {
    const p = previewOf(
      `<b>Tin</b>\n&lt;x&gt; ${"a".repeat(500)} 123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh`
    )
    expect(p.startsWith("Tin <x> ")).toBe(true)
    expect(p.length).toBeLessThanOrEqual(300)
    expect(
      previewOf("token 123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh")
    ).not.toContain("AAEhBP0av28")
  })
})
