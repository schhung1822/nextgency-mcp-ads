// drf_ refs (security review L1): opaque, bound to the MCP, tamper-proof, expiring; never contain the resource key.
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"

import { __setKeyRing } from "@/server/crypto/secret-box"

import {
  decodeDriveFileRef,
  DRIVE_FILE_REF_PREFIX,
  DRIVE_FILE_REF_TTL_MS,
  encodeDriveFileRef,
  isDriveFileRef,
} from "./file-ref"

const mcpA = randomUUID()
const mcpB = randomUUID()
const fileId = "1AbCdEfGhIjKlMnOpQrStUvWx"
const resourceKey = "0-AbCdEfGhIjKlMnOp"
const NOW = 1_791_500_000_000

afterEach(() => __setKeyRing(undefined))

describe("drive file refs", () => {
  it("round-trips for the same MCP and hides the resource key", () => {
    const ref = encodeDriveFileRef(mcpA, { fileId, resourceKey }, NOW)
    expect(ref.startsWith(DRIVE_FILE_REF_PREFIX)).toBe(true)
    expect(isDriveFileRef(ref)).toBe(true)
    expect(ref).toMatch(/^drf_[A-Za-z0-9_-]+$/)
    expect(ref.length).toBeLessThan(1024)
    expect(ref).not.toContain(resourceKey)
    expect(ref).not.toContain(fileId)
    expect(Buffer.from(ref.slice(4), "base64url").toString()).not.toContain(
      resourceKey
    )
    expect(decodeDriveFileRef(mcpA, ref, NOW + 1000)).toEqual({
      fileId,
      resourceKey,
    })
    // two refs of the same file differ (random IV)
    expect(encodeDriveFileRef(mcpA, { fileId, resourceKey }, NOW)).not.toBe(ref)
    // without a resource key
    const plain = encodeDriveFileRef(mcpA, { fileId, resourceKey: null }, NOW)
    expect(decodeDriveFileRef(mcpA, plain, NOW)).toEqual({
      fileId,
      resourceKey: null,
    })
  })

  it("is useless for another MCP", () => {
    const ref = encodeDriveFileRef(mcpA, { fileId, resourceKey }, NOW)
    expect(decodeDriveFileRef(mcpB, ref, NOW)).toBeNull()
  })

  it("expires after DRIVE_FILE_REF_TTL_MS", () => {
    const ref = encodeDriveFileRef(mcpA, { fileId, resourceKey }, NOW)
    expect(
      decodeDriveFileRef(mcpA, ref, NOW + DRIVE_FILE_REF_TTL_MS - 1)
    ).not.toBeNull()
    expect(
      decodeDriveFileRef(mcpA, ref, NOW + DRIVE_FILE_REF_TTL_MS)
    ).toBeNull()
  })

  it("tampered / malformed / oversized refs → null (never throws)", () => {
    const ref = encodeDriveFileRef(mcpA, { fileId, resourceKey }, NOW)
    const body = Buffer.from(ref.slice(4), "base64url").toString("utf8")
    const parts = body.split(".")
    // flip one ciphertext character
    const ct = parts[3]!
    parts[3] = (ct[0] === "A" ? "B" : "A") + ct.slice(1)
    const tampered = "drf_" + Buffer.from(parts.join(".")).toString("base64url")
    for (const bad of [
      tampered,
      "drf_",
      "drf_!!!",
      "drf_" + "A".repeat(2000),
      "drf_" + Buffer.from("v1.a.b.c").toString("base64url"),
      ref.slice(0, -3),
      "https://drive.google.com/file/d/" + fileId,
      "",
    ])
      expect(decodeDriveFileRef(mcpA, bad, NOW), bad.slice(0, 30)).toBeNull()
    expect(isDriveFileRef("https://drive.google.com/x")).toBe(false)
    expect(decodeDriveFileRef("", ref, NOW)).toBeNull()
  })

  it("survives key rotation (old key kept for decryption), dies when the key is removed", () => {
    const k1 = Buffer.alloc(32, 1).toString("base64")
    const k2 = Buffer.alloc(32, 2).toString("base64")
    __setKeyRing(`1:${k1}`)
    const ref = encodeDriveFileRef(mcpA, { fileId, resourceKey }, NOW)
    __setKeyRing(`2:${k2},1:${k1}`)
    expect(decodeDriveFileRef(mcpA, ref, NOW)?.fileId).toBe(fileId)
    __setKeyRing(`2:${k2}`)
    expect(decodeDriveFileRef(mcpA, ref, NOW)).toBeNull()
  })

  it("refuses to encode invalid input", () => {
    expect(() =>
      encodeDriveFileRef(mcpA, { fileId: "../x", resourceKey: null })
    ).toThrow()
    expect(() =>
      encodeDriveFileRef("", { fileId, resourceKey: null })
    ).toThrow()
    expect(() =>
      encodeDriveFileRef(mcpA, { fileId, resourceKey: "" })
    ).toThrow()
    expect(() =>
      encodeDriveFileRef(mcpA, { fileId, resourceKey: "x".repeat(201) })
    ).toThrow()
  })
})
