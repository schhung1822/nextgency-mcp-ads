// Every activity_logs action is wired end to end: declared once (ActivityAction), produced somewhere in the
// server code, labelled in Vietnamese in BOTH places the UI shows it (Logs → "Nhật ký nhân sự" and Account →
// "Hoạt động của tôi"), filterable by group on the Logs page, and listed in the database documentation.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { account as tAccount } from "@/lib/i18n/vi/account"
import { logs as tl } from "@/lib/i18n/vi/logs"
import { ACTIVITY_GROUPS } from "@/lib/schemas/logs"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8")

/** `| "a.b.c"` members of the ActivityAction union. */
function declaredActions(): string[] {
  const src = read("src/server/audit/activity-log.ts")
  const union = /export type ActivityAction =([\s\S]*?)\n\nexport interface/.exec(src)?.[1] ?? ""
  return [...union.matchAll(/\|\s*"([a-z0-9_.]+)"/g)].map((m) => m[1]!)
}

function sourceFiles(dir: string): string[] {
  return (readdirSync(path.join(ROOT, dir), { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !/__tests__|__dev__|__fixtures__/.test(f))
    .map((f) => path.join(dir, f))
}

const actions = declaredActions()

describe("danh mục activity_logs.action", () => {
  it("đọc được đủ danh mục (37 hành động của 03-database-schema.md §4)", () => {
    expect(actions.length).toBe(37)
    expect(new Set(actions).size).toBe(actions.length)
  })

  it("mỗi hành động đều có nhãn tiếng Việt ở Nhật ký nhân sự VÀ Hoạt động của tôi, không nhãn thừa", () => {
    const logLabels = tl.actions as Record<string, string>
    const mineLabels = tAccount.actionLabels as Record<string, string>
    for (const a of actions) {
      expect(logLabels[a], `Nhật ký: thiếu nhãn ${a}`).toBeTruthy()
      expect(mineLabels[a], `Tài khoản: thiếu nhãn ${a}`).toBeTruthy()
      // a label is a human sentence, not the code itself
      expect(logLabels[a]).not.toBe(a)
      expect(mineLabels[a]).not.toBe(a)
    }
    expect(Object.keys(logLabels).sort()).toEqual([...actions].sort())
    expect(Object.keys(mineLabels).sort()).toEqual([...actions].sort())
  })

  it("nhóm tiền tố của mọi hành động nằm trong bộ lọc nhóm của trang Nhật ký", () => {
    for (const a of actions) expect(ACTIVITY_GROUPS as readonly string[], a).toContain(a.split(".")[0])
  })

  it("mỗi hành động có ít nhất một nơi ghi trong mã (không có hành động 'ma')", () => {
    const files = [...sourceFiles("src/server"), ...sourceFiles("src/app"), "scripts/cli.ts"].filter(
      (f) => !f.endsWith(path.join("audit", "activity-log.ts")) && !f.includes(path.join("src", "lib"))
    )
    const text = files.map((f) => read(f)).join("\n")
    const missing = actions.filter((a) => !text.includes(`"${a}"`))
    expect(missing).toEqual([])
  })

  it("tài liệu 03-database-schema.md §4 liệt kê đúng cùng danh mục", () => {
    const doc = read(".claude/docs/03-database-schema.md")
    const section = /## 4\. Danh mục `activity_logs\.action`\n([\s\S]*?)\n##/.exec(doc)?.[1] ?? ""
    // the section also mentions code identifiers in prose (e.g. `hooks.after`): keep action codes only
    const documented = [...section.matchAll(/`([a-z0-9_.]+)`/g)]
      .map((m) => m[1]!)
      .filter((x) => (ACTIVITY_GROUPS as readonly string[]).includes(x.split(".")[0]!) && x.includes("."))
    expect([...new Set(documented)].sort()).toEqual([...actions].sort())
  })

  it("nhật ký nhân sự không bao giờ ghi các khoá bí mật dù metadata có chứa (redact trước khi lưu)", async () => {
    const { redact } = await import("@/server/audit/redact")
    const out = redact({ password: "p", newPassword: "n", currentPassword: "c", token: "t", code: "123456", backupCodes: ["a"], nested: { secret: "s", apiKey: "k" }, email: "a@b.vn" }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toMatch(/"(p|n|c|t|s|k)"/)
    expect(out.email).toBe("a@b.vn")
  })
})
