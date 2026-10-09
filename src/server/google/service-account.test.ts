// Shared service-account helper: JSON key parsing (never echoes the key), RS256 JWT, token cache keyed by
// cacheKey + key identity + scopes, early refresh, de-duplication, invalidation, token endpoint errors / retries.
import { createVerify } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { drive as dm } from "@/lib/i18n/vi/drive"
import {
  isToken,
  json,
  mockGoogleFetch,
  saJson,
  SA_EMAIL,
  testKeyPair,
  testServiceAccount,
} from "../drive/__fixtures__/google-fetch"
import {
  __clearGoogleTokenCache,
  __setGoogleTokenRetryBaseMs,
  getGoogleAccessToken,
  getGoogleAccessTokenInfo,
  GoogleAuthError,
  googleTokenCacheKey,
  invalidateGoogleAccessTokens,
  parseServiceAccountJson,
  signGoogleJwt,
} from "./service-account"

const DRIVE = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
]
const ADWORDS = ["https://www.googleapis.com/auth/adwords"]

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >

function assertionOf(body: string | null): Record<string, unknown> {
  const a = new URLSearchParams(body ?? "").get("assertion") ?? ""
  return decode(a.split(".")[1]!)
}

function authError(fn: () => unknown): GoogleAuthError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(GoogleAuthError)
    return e as GoogleAuthError
  }
  throw new Error("no error")
}

beforeEach(() => {
  __clearGoogleTokenCache()
  __setGoogleTokenRetryBaseMs(1)
})
afterEach(() => __setGoogleTokenRetryBaseMs(1_000))

describe("parseServiceAccountJson", () => {
  it("đọc khoá JSON tải từ Google Cloud", () => {
    const sa = parseServiceAccountJson(saJson())
    expect(sa).toEqual({
      clientEmail: SA_EMAIL,
      privateKey: expect.stringContaining(
        "-----BEGIN PRIVATE KEY-----"
      ) as unknown,
      privateKeyId: "kid-drive-1",
      projectId: "demo-project",
    })
  })

  it('chấp nhận private_key có "\\n" viết chữ (dán từ file env)', () => {
    const escaped = testKeyPair().privateKey.replace(/\n/g, "\\n")
    const sa = parseServiceAccountJson(saJson({ private_key: escaped }))
    expect(sa.privateKey).toContain("\n")
    expect(sa.privateKey).not.toContain("\\n")
  })

  it("từ chối mọi thứ không phải khoá service account, không lặp lại nội dung khoá", () => {
    const cases: [string, string][] = [
      ["not json", dm.serviceAccount.notJson],
      ["[1,2]", dm.serviceAccount.notJson],
      [
        saJson({ type: "authorized_user" }),
        dm.serviceAccount.notServiceAccount,
      ],
      [saJson({ type: undefined }), dm.serviceAccount.notServiceAccount],
      [saJson({ client_email: "" }), dm.serviceAccount.missingEmail],
      [saJson({ private_key: "" }), dm.serviceAccount.missingKey],
      [
        saJson({
          private_key:
            "-----BEGIN PRIVATE KEY-----\nMIIBOGUSKEYDATA\n-----END PRIVATE KEY-----\n",
        }),
        dm.serviceAccount.badKey,
      ],
    ]
    for (const [raw, vi] of cases) {
      const e = authError(() => parseServiceAccountJson(raw))
      expect(e.code).toBe("invalid_json")
      expect(e.userMessageVi).toBe(vi)
      const dump = `${e.message} ${JSON.stringify(e)} ${String(e.cause ?? "")}`
      expect(dump).not.toContain("MII")
      expect(dump).not.toContain("PRIVATE KEY")
    }
  })
})

describe("signGoogleJwt", () => {
  it("iss / scope / aud cố định / exp 1 giờ, kid, không có sub, chữ ký RS256 hợp lệ", () => {
    const now = Date.UTC(2026, 9, 9)
    const jwt = signGoogleJwt(testServiceAccount(), DRIVE, now)
    const [h, c, s] = jwt.split(".")
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-drive-1" })
    expect(decode(c!)).toEqual({
      iss: SA_EMAIL,
      scope: DRIVE.join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat: now / 1000,
      exp: now / 1000 + 3600,
    })
    const v = createVerify("RSA-SHA256")
    v.update(`${h}.${c}`)
    expect(
      v.verify(testKeyPair().publicKey, Buffer.from(s!, "base64url"))
    ).toBe(true)
  })

  it("khoá hỏng → invalid_json", () => {
    const e = authError(() =>
      signGoogleJwt(testServiceAccount({ privateKey: "garbage" }), DRIVE)
    )
    expect(e.code).toBe("invalid_json")
  })
})

describe("token cache", () => {
  it("gửi jwt-bearer tới oauth2.googleapis.com (không theo token_uri trong JSON)", async () => {
    const m = mockGoogleFetch()
    const sa = parseServiceAccountJson(saJson())
    const t = await getGoogleAccessToken(sa, DRIVE, {
      cacheKey: "drive_credential:a",
    })
    expect(t).toBe("ya29.test-token-1")
    const call = m.tokenCalls()[0]!
    expect(call.url.href).toBe("https://oauth2.googleapis.com/token")
    expect(call.method).toBe("POST")
    expect(new URLSearchParams(call.body ?? "").get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer"
    )
    expect(assertionOf(call.body).scope).toBe(DRIVE.join(" "))
  })

  it("khoá cache gồm scope: cùng service account cho Google Ads và Drive không dùng chung token", async () => {
    const m = mockGoogleFetch()
    const sa = testServiceAccount()
    const a = await getGoogleAccessToken(sa, ADWORDS, { cacheKey: "k" })
    const d = await getGoogleAccessToken(sa, DRIVE, { cacheKey: "k" })
    expect(a).not.toBe(d)
    expect(m.tokenCalls().map((c) => assertionOf(c.body).scope)).toEqual([
      ADWORDS.join(" "),
      DRIVE.join(" "),
    ])
    // same scopes in another order → same token
    expect(
      await getGoogleAccessToken(sa, [...DRIVE].reverse(), { cacheKey: "k" })
    ).toBe(d)
    expect(m.tokenCalls()).toHaveLength(2)
  })

  it("khoá cache gồm cacheKey và danh tính khoá", async () => {
    const m = mockGoogleFetch()
    const sa = testServiceAccount()
    await getGoogleAccessToken(sa, DRIVE, { cacheKey: "a" })
    await getGoogleAccessToken(sa, DRIVE, { cacheKey: "b" })
    await getGoogleAccessToken({ ...sa, privateKeyId: "kid-2" }, DRIVE, {
      cacheKey: "a",
    })
    expect(m.tokenCalls()).toHaveLength(3)
    const key = googleTokenCacheKey(sa, DRIVE, "a")
    expect(key).toBe(`a|${SA_EMAIL}|kid-drive-1|${[...DRIVE].sort().join(" ")}`)
    expect(key).not.toContain("PRIVATE")
  })

  it("dùng lại token tới 5 phút trước khi hết hạn; forceRefresh xin token mới", async () => {
    const m = mockGoogleFetch({ expiresIn: 3600 })
    const sa = testServiceAccount()
    let now = 1_000_000
    const t1 = await getGoogleAccessTokenInfo(sa, DRIVE, {
      cacheKey: "c",
      now: () => now,
    })
    expect(t1.expiresAt).toBe(1_000_000 + 3_600_000)
    now += 54 * 60_000
    expect(
      (
        await getGoogleAccessTokenInfo(sa, DRIVE, {
          cacheKey: "c",
          now: () => now,
        })
      ).accessToken
    ).toBe(t1.accessToken)
    now += 2 * 60_000
    const t3 = await getGoogleAccessTokenInfo(sa, DRIVE, {
      cacheKey: "c",
      now: () => now,
    })
    expect(t3.accessToken).not.toBe(t1.accessToken)
    const t4 = await getGoogleAccessToken(sa, DRIVE, {
      cacheKey: "c",
      forceRefresh: true,
    })
    expect(t4).not.toBe(t3.accessToken)
    expect(m.tokenCalls()).toHaveLength(3)
  })

  it("gộp các lượt xin token đồng thời", async () => {
    const m = mockGoogleFetch()
    const sa = testServiceAccount()
    const [a, b] = await Promise.all([
      getGoogleAccessToken(sa, DRIVE, { cacheKey: "x" }),
      getGoogleAccessToken(sa, DRIVE, { cacheKey: "x" }),
    ])
    expect(a).toBe(b)
    expect(m.tokenCalls()).toHaveLength(1)
  })

  it("invalidateGoogleAccessTokens chỉ xoá đúng cacheKey (không xoá theo tiền tố chuỗi)", async () => {
    const m = mockGoogleFetch()
    const sa = testServiceAccount()
    await getGoogleAccessToken(sa, DRIVE, { cacheKey: "drive_credential:1" })
    await getGoogleAccessToken(sa, DRIVE, { cacheKey: "drive_credential:10" })
    invalidateGoogleAccessTokens("drive_credential:1")
    await getGoogleAccessToken(sa, DRIVE, { cacheKey: "drive_credential:1" })
    await getGoogleAccessToken(sa, DRIVE, { cacheKey: "drive_credential:10" })
    expect(m.tokenCalls()).toHaveLength(3)
  })
})

describe("token endpoint errors", () => {
  it("invalid_grant → GoogleAuthError invalid_grant, mô tả đã che bí mật", async () => {
    const m = mockGoogleFetch()
    m.on(isToken, () =>
      json(
        {
          error: "invalid_grant",
          error_description:
            "Invalid JWT Signature. ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxx",
        },
        400
      )
    )
    const e = (await getGoogleAccessToken(testServiceAccount(), DRIVE, {
      cacheKey: "e",
    }).catch((x: unknown) => x)) as GoogleAuthError
    expect(e).toBeInstanceOf(GoogleAuthError)
    expect(e.code).toBe("invalid_grant")
    expect(e.oauthError).toBe("invalid_grant")
    expect(e.httpStatus).toBe(400)
    expect(e.detail).toContain("Invalid JWT Signature")
    expect(e.detail).not.toContain("a0AfH6SMB")
    expect(m.tokenCalls()).toHaveLength(1)
  })

  it("invalid_client / invalid_scope", async () => {
    const m = mockGoogleFetch()
    m.once(isToken, () => json({ error: "invalid_client" }, 401))
    m.once(isToken, () => json({ error: "invalid_scope" }, 400))
    const sa = testServiceAccount()
    const e1 = (await getGoogleAccessToken(sa, DRIVE, { cacheKey: "1" }).catch(
      (x: unknown) => x
    )) as GoogleAuthError
    const e2 = (await getGoogleAccessToken(sa, DRIVE, { cacheKey: "2" }).catch(
      (x: unknown) => x
    )) as GoogleAuthError
    expect(e1.code).toBe("unauthorized_client")
    expect(e2.code).toBe("invalid_scope")
  })

  it("5xx / 429 được thử lại (tối đa 2 lần) rồi thành công", async () => {
    const m = mockGoogleFetch()
    m.once(isToken, () => json({ error: "backend" }, 503))
    m.once(isToken, () => json({ error: "rate" }, 429))
    expect(
      await getGoogleAccessToken(testServiceAccount(), DRIVE, { cacheKey: "r" })
    ).toBe("ya29.test-token-1")
    expect(m.tokenCalls()).toHaveLength(3)
  })

  it("5xx liên tục → upstream sau 3 lượt", async () => {
    const m = mockGoogleFetch()
    m.on(isToken, () => json({}, 500))
    const e = (await getGoogleAccessToken(testServiceAccount(), DRIVE, {
      cacheKey: "u",
    }).catch((x: unknown) => x)) as GoogleAuthError
    expect(e.code).toBe("upstream")
    expect(e.httpStatus).toBe(500)
    expect(m.tokenCalls()).toHaveLength(3)
  })

  it("lỗi mạng → network, không thử lại, không đưa khoá vào thông báo", async () => {
    const m = mockGoogleFetch()
    m.on(isToken, () => {
      throw new TypeError("fetch failed")
    })
    const e = (await getGoogleAccessToken(testServiceAccount(), DRIVE, {
      cacheKey: "n",
    }).catch((x: unknown) => x)) as GoogleAuthError
    expect(e.code).toBe("network")
    expect(e.timedOut).toBe(false)
    expect(m.tokenCalls()).toHaveLength(1)
    expect(e.message).not.toContain("PRIVATE")
  })
})
