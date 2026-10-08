import { describe, expect, it } from "vitest"
import { viMessage } from "./__fixtures__/mock-fetch"
import { assertId, escapeLike, gaqlString, idList, likeContains, normalizeCustomerId, parseCompositeId, statusCondition } from "./gaql"

describe("GAQL escaping", () => {
  it("escapes quotes and backslashes in string literals", () => {
    expect(gaqlString("O'Reilly")).toBe("'O\\'Reilly'")
    expect(gaqlString('a"b\\c')).toBe("'a\\\"b\\\\c'")
  })

  it("rejects newlines/control characters (PROHIBITED_NEWLINE_IN_STRING)", () => {
    expect(() => gaqlString("a\nb")).toThrow()
    expect(() => gaqlString("a\u0000")).toThrow()
  })

  it("escapes LIKE wildcards with brackets", () => {
    expect(escapeLike("50%_off [sale]")).toBe("50[%][_]off [[]sale[]]")
    expect(likeContains("campaign.name", "Tết 50%")).toBe("campaign.name LIKE '%Tết 50[%]%'")
  })

  it("neutralises injection attempts", () => {
    const evil = "x' OR campaign.id > 0 AND campaign.name LIKE '"
    const cond = likeContains("campaign.name", evil)
    // the whole payload stays inside one literal: every inner quote is escaped
    expect(cond).toBe("campaign.name LIKE '%x\\' OR campaign.id > 0 AND campaign.name LIKE \\'%'")
  })
})

describe("id validation", () => {
  it("accepts digits only", () => {
    expect(assertId(" 123 ")).toBe("123")
    expect(viMessage(() => assertId("12 OR 1=1"))).toMatch(/chữ số/)
    expect(() => assertId("-1")).toThrow()
    expect(() => assertId("")).toThrow()
    expect(idList(["1", "2", "1"])).toBe("(1, 2)")
    expect(() => idList([])).toThrow()
  })

  it("normalizes customer ids", () => {
    expect(normalizeCustomerId("123-456-7890")).toBe("1234567890")
    expect(() => normalizeCustomerId("123")).toThrow()
  })

  it("parses composite AG~ID ids", () => {
    expect(parseCompositeId("111~222")).toEqual({ adGroupId: "111", id: "222" })
    expect(parseCompositeId("222")).toEqual({ adGroupId: null, id: "222" })
    expect(() => parseCompositeId("1~2~3")).toThrow()
    expect(() => parseCompositeId("1~x")).toThrow()
  })
})

describe("status condition", () => {
  it("excludes REMOVED by default and maps normalized statuses", () => {
    expect(statusCondition("campaign.status", undefined)).toBe("campaign.status != 'REMOVED'")
    expect(statusCondition("campaign.status", undefined, true)).toBeNull()
    expect(statusCondition("ad_group.status", ["active", "paused"])).toBe("ad_group.status IN ('ENABLED', 'PAUSED')")
  })
})
