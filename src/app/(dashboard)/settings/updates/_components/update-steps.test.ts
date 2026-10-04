import { describe, expect, it } from "vitest"

import { isFinished, stepRows } from "./update-steps"

const states = (rows: ReturnType<typeof stepRows>) => rows.map((r) => `${r.step}:${r.state}`)

describe("stepRows", () => {
  it("đang chờ: mọi bước đều chờ", () => {
    expect(states(stepRows({ status: "pending", step: null }))).toEqual([
      "backup:todo",
      "pull:todo",
      "migrate:todo",
      "restart:todo",
      "healthcheck:todo",
    ])
  })

  it("đang chạy: các bước trước xong, bước hiện tại chạy, phần còn lại chờ", () => {
    expect(states(stepRows({ status: "running", step: "migrate" }))).toEqual([
      "backup:done",
      "pull:done",
      "migrate:current",
      "restart:todo",
      "healthcheck:todo",
    ])
  })

  it("đang chạy nhưng chưa báo bước: bước đầu là bước hiện tại", () => {
    expect(stepRows({ status: "running", step: null })[0]).toEqual({ step: "backup", state: "current" })
  })

  it("thành công: tất cả xong", () => {
    expect(stepRows({ status: "succeeded", step: "healthcheck" }).every((r) => r.state === "done")).toBe(true)
  })

  it("thất bại ở một bước: đánh dấu lỗi đúng bước", () => {
    expect(states(stepRows({ status: "failed", step: "pull" }))).toEqual([
      "backup:done",
      "pull:failed",
      "migrate:todo",
      "restart:todo",
      "healthcheck:todo",
    ])
  })

  it("quay về bản cũ: thêm dòng rollback đã xong", () => {
    const rows = stepRows({ status: "rolled_back", step: "rollback" })
    expect(rows.at(-1)).toEqual({ step: "rollback", state: "done" })
    expect(rows).toHaveLength(6)
  })

  it("isFinished", () => {
    expect(isFinished("pending")).toBe(false)
    expect(isFinished("running")).toBe(false)
    expect(isFinished("succeeded")).toBe(true)
    expect(isFinished("failed")).toBe(true)
    expect(isFinished("rolled_back")).toBe(true)
  })
})
