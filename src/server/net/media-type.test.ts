// Shared magic-byte detection (Telegram + Drive): neutral MediaTypeError reasons, image/video-only sniffing.
// The full allowlist matrix is covered through the Telegram wrapper in notifications/media.test.ts.
import { describe, expect, it } from "vitest"

import {
  detectFileType,
  extOf,
  FILE_TYPES,
  isMediaTypeError,
  isTextExt,
  MediaTypeError,
  sniffMediaType,
} from "./media-type"

function ftyp(major: string, ...compatible: string[]): Buffer {
  const body = Buffer.from(
    `ftyp${major}\x00\x00\x02\x00${compatible.join("")}`,
    "latin1"
  )
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length + 4)
  return Buffer.concat([size, body, Buffer.alloc(16)])
}

/** minimal ZIP (stored, empty entries) with a real central directory */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const n of names) {
    const name = Buffer.from(n, "utf8")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const reasonOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    expect(isMediaTypeError(e)).toBe(true)
    return (e as MediaTypeError).reason
  }
  return null
}

describe("sniffMediaType", () => {
  it("ảnh / video theo vài byte đầu, null cho mọi thứ khác (không ném lỗi)", () => {
    expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      FILE_TYPES.jpg
    )
    expect(
      sniffMediaType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe(FILE_TYPES.png)
    expect(sniffMediaType(Buffer.from("GIF89a", "latin1"))).toBe(FILE_TYPES.gif)
    expect(sniffMediaType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toBe(
      FILE_TYPES.webp
    )
    expect(sniffMediaType(ftyp("isom", "mp41"))).toBe(FILE_TYPES.mp4)
    expect(sniffMediaType(ftyp("qt  "))).toBe(FILE_TYPES.mov)
    expect(sniffMediaType(ftyp("heic", "mif1"))).toBeNull()
    expect(sniffMediaType(Buffer.from("%PDF-1.7"))).toBeNull()
    expect(sniffMediaType(Buffer.from("<html>"))).toBeNull()
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull()
  })
})

describe("detectFileType (lỗi trung tính)", () => {
  it("lý do từ chối", () => {
    expect(
      reasonOf(() => detectFileType(Buffer.from("MZ\x90\0", "latin1")))
    ).toBe("not_allowed")
    expect(
      reasonOf(() =>
        detectFileType(
          zip([
            "[Content_Types].xml",
            "word/document.xml",
            "word/vbaProject.bin",
          ])
        )
      )
    ).toBe("macro")
    expect(
      reasonOf(() =>
        detectFileType(
          zip([
            "[Content_Types].xml",
            "word/document.xml",
            "word/embeddings/oleObject1.bin",
          ])
        )
      )
    ).toBe("office_embedded")
    expect(
      reasonOf(() =>
        detectFileType(Buffer.from("<!DOCTYPE html><p>"), { name: "a.txt" })
      )
    ).toBe("markup")
    expect(reasonOf(() => detectFileType(Buffer.from("a,b"), {}))).toBe(
      "not_allowed"
    )
  })

  it("loại được phép", () => {
    expect(
      detectFileType(zip(["[Content_Types].xml", "xl/workbook.xml"])).ext
    ).toBe("xlsx")
    expect(detectFileType(Buffer.from("a,b\n1,2"), { name: "x.csv" }).ext).toBe(
      "csv"
    )
    expect(detectFileType(ftyp("mp42")).family).toBe("video")
  })

  it("extOf / isTextExt", () => {
    expect(extOf("Ảnh.JPG")).toBe("jpg")
    expect(extOf("noext")).toBeNull()
    expect(isTextExt("md")).toBe(true)
    expect(isTextExt("html")).toBe(false)
    expect(isTextExt(null)).toBe(false)
  })
})
