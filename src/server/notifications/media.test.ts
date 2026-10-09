// Attachments (§10.2-§10.3): magic-byte allowlist (images, MP4/MOV, PDF, DOCX/XLSX/PPTX by ZIP entry names, macro
// refused, text types), photo / video / document choice, file-name sanitising, AI text files (redaction, CSV
// formula neutralisation + BOM, 256 KB cap), downloads through an injected fetch (https only, internal hosts,
// redirects, size cap, timeouts, no URL in any message), the production path's safeFetch options and error
// mapping (safeFetch mocked - no network), the per-process semaphore and the preview label.
import { afterEach, describe, expect, it, vi } from "vitest"

import { notifications as m } from "@/lib/i18n/vi/notifications"
import { invalid } from "@/server/mcp/errors"
import { assertPublicUrlSyntax, safeFetch } from "@/server/net/ssrf"

import {
  detectFileType,
  formatFileSize,
  isTelegramMediaError,
  MEDIA_SLOTS,
  mediaPreviewLabel,
  neutralizeFormulas,
  prepareAttachment,
  resolveMediaKind,
  sanitizeFileName,
  setMediaFetchImpl,
  TELEGRAM_PHOTO_MAX_BYTES,
  TELEGRAM_TEXT_FILE_MAX_BYTES,
  TELEGRAM_UPLOAD_MAX_BYTES,
  TelegramMediaError,
  withMediaSlot,
  zipEntryNames,
  type AttachmentSource,
  type SendAs,
} from "./media"

vi.mock("@/server/net/ssrf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/net/ssrf")>()),
  safeFetch: vi.fn(),
}))

const TG_TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
const BOM = String.fromCharCode(0xfeff)

// --- sample files ---------------------------------------------------------
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")
const WEBP = Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1")
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1")
function ftyp(major: string, ...compatible: string[]): Buffer {
  const body = Buffer.from(
    `ftyp${major}\x00\x00\x02\x00${compatible.join("")}`,
    "latin1"
  )
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length + 4)
  return Buffer.concat([size, body, Buffer.alloc(16)])
}
const MP4 = ftyp("isom", "isom", "iso2", "avc1", "mp41")
const MOV = ftyp("qt  ", "qt  ")
const HEIC = ftyp("heic", "mif1", "heic")

/** minimal ZIP (stored, empty entries) with a real central directory */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const name of names) {
    const n = Buffer.from(name, "utf8")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n)
    centrals.push(central, n)
    offset += 30 + n.length
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
const DOCX = zip(["[Content_Types].xml", "_rels/.rels", "word/document.xml"])
const XLSX = zip([
  "[Content_Types].xml",
  "xl/workbook.xml",
  "xl/worksheets/sheet1.xml",
])
const PPTX = zip(["[Content_Types].xml", "ppt/presentation.xml"])
const DOCM = zip([
  "[Content_Types].xml",
  "word/document.xml",
  "word/vbaProject.bin",
])
const PLAIN_ZIP = zip(["a.exe", "b.txt"])
const XLSX_PRINTER = zip([
  "[Content_Types].xml",
  "xl/workbook.xml",
  "xl/printerSettings/printerSettings1.bin",
])

function mediaError(fn: () => unknown): TelegramMediaError {
  try {
    fn()
  } catch (e) {
    if (isTelegramMediaError(e)) return e
    throw e
  }
  throw new Error("expected a TelegramMediaError")
}
async function mediaErrorAsync(
  p: Promise<unknown>
): Promise<TelegramMediaError> {
  try {
    await p
  } catch (e) {
    if (isTelegramMediaError(e)) return e
    throw e
  }
  throw new Error("expected a TelegramMediaError")
}

afterEach(() => {
  setMediaFetchImpl(null)
  vi.useRealTimers()
})

describe("detectFileType (magic bytes, không tin Content-Type / đuôi)", () => {
  it.each([
    [JPEG, "jpg", "image/jpeg"],
    [PNG, "png", "image/png"],
    [GIF, "gif", "image/gif"],
    [WEBP, "webp", "image/webp"],
    [MP4, "mp4", "video/mp4"],
    [MOV, "mov", "video/quicktime"],
    [PDF, "pdf", "application/pdf"],
    [DOCX, "docx", expect.stringContaining("wordprocessingml")],
    [XLSX, "xlsx", expect.stringContaining("spreadsheetml")],
    [PPTX, "pptx", expect.stringContaining("presentationml")],
  ])("nhận diện %#", (bytes, ext, mime) => {
    // a lying name / mime changes nothing
    expect(
      detectFileType(bytes as Buffer, { name: "x.exe", mime: "text/html" })
    ).toMatchObject({ ext, mime })
  })

  it("Office có macro (vbaProject.bin) bị chặn với lý do riêng", () => {
    const e = mediaError(() => detectFileType(DOCM))
    expect(e.code).toBe("telegram_file_type_not_allowed")
    expect(e.userMessageVi).toBe(m.media.macro)
  })

  it("Office: cần [Content_Types].xml + đúng 1 phần chính (không còn đoán theo thư mục)", () => {
    for (const names of [
      ["[Content_Types].xml", "word/styles.xml"],
      ["[Content_Types].xml", "xl/worksheets/sheet1.xml"],
      ["[Content_Types].xml", "ppt/slides/slide1.xml"],
      ["word/document.xml"],
      ["[Content_Types].xml", "word/document.xml", "xl/workbook.xml"],
    ]) {
      const e = mediaError(() => detectFileType(zip(names)))
      expect(e.code).toBe("telegram_file_type_not_allowed")
      expect(e.userMessageVi).not.toBe(m.media.officeEmbedded)
    }
  })

  it("Office: chặn OLE (embeddings/), ActiveX, .bin bất kỳ, tệp chạy được, '..' và đường dẫn tuyệt đối; printerSettings*.bin được phép", () => {
    expect(detectFileType(XLSX_PRINTER).ext).toBe("xlsx")
    for (const extra of [
      "word/embeddings/oleObject1.bin",
      "xl/embeddings/Microsoft_Word_Document.docx",
      "word/activeX/activeX1.xml",
      "ppt/media/payload.bin",
      "customXml/item1.bin",
      "word/media/run.EXE",
      "xl/media/x.js",
      "docProps/a.hta",
      "word/../../evil.xml",
      "..\\evil.xml",
      "/etc/x.xml",
      "C:/Windows/x.xml",
    ]) {
      const e = mediaError(() =>
        detectFileType(zip(["[Content_Types].xml", "word/document.xml", extra]))
      )
      expect(e.code, extra).toBe("telegram_file_type_not_allowed")
      expect(e.userMessageVi, extra).toBe(m.media.officeEmbedded)
      expect(e.hintVi).toBe(m.media.officeEmbeddedHint)
    }
  })

  it("chặn exe, zip thường, HEIC, SVG/HTML, nhị phân không rõ", () => {
    for (const b of [
      Buffer.from("MZ\x90\x00\x03\x00", "latin1"),
      PLAIN_ZIP,
      HEIC,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from([1, 2, 3, 4, 5]),
    ]) {
      expect(mediaError(() => detectFileType(b, {})).code).toBe(
        "telegram_file_type_not_allowed"
      )
    }
    // markup is refused even when named .txt
    const html = mediaError(() =>
      detectFileType(Buffer.from("<!DOCTYPE html><html></html>"), {
        name: "a.txt",
      })
    )
    expect(html.userMessageVi).toBe(m.media.markup)
  })

  it("markup: chú thích / doctype / khai báo XML ở đầu, hoặc thẻ svg/html/script/iframe trong 1 KB đầu (mọi kiểu chữ)", () => {
    const prose = "Báo cáo tuần: chi tiêu < 5 triệu, ROAS > 2.\n".repeat(10)
    for (const s of [
      "<!-- ghi chú --><p>x</p>",
      "  <!DOCTYPE note><note/>",
      "<?XML version='1.0'?><a/>",
      `${prose}<SvG onload=alert(1)>`,
      `${prose}<script>alert(1)</script>`,
      `${prose}<Html>`,
      `${prose}<iframe src=x>`,
      `${String.fromCharCode(0xfeff)}<!--x-->`,
    ]) {
      const e = mediaError(() =>
        detectFileType(Buffer.from(s), { name: "a.txt" })
      )
      expect(e.userMessageVi, s.slice(-30)).toBe(m.media.markup)
    }
    // plain text with < > and a tag-like word after the first 1 KB stays text
    expect(
      detectFileType(Buffer.from(prose), { name: "a.md" }).ext
    ).toBe("md")
    expect(
      detectFileType(Buffer.from(`${"x".repeat(1100)}<script>`), {
        name: "a.txt",
      }).ext
    ).toBe("txt")
    expect(
      detectFileType(Buffer.from("a <svgx> b <scripting>"), { name: "a.txt" })
        .ext
    ).toBe("txt")
  })

  it("tệp chữ: cần đuôi/mime csv-tsv-txt-md-json + UTF-8 hợp lệ, không NUL; tên có đuôi khác thì không tin mime", () => {
    const csv = Buffer.from("a,b\n1,2\n")
    expect(detectFileType(csv, { name: "bao-cao.csv" }).ext).toBe("csv")
    expect(detectFileType(csv, { mime: "text/csv; charset=utf-8" }).ext).toBe(
      "csv"
    )
    expect(detectFileType(Buffer.from("{}"), { name: "a.JSON" }).ext).toBe(
      "json"
    )
    expect(() => detectFileType(csv, {})).toThrow(TelegramMediaError)
    expect(() =>
      detectFileType(csv, { name: "a.html", mime: "text/plain" })
    ).toThrow(TelegramMediaError)
    expect(() =>
      detectFileType(Buffer.from([0x61, 0x00, 0x62]), { name: "a.txt" })
    ).toThrow(TelegramMediaError)
    expect(() =>
      detectFileType(Buffer.from([0x61, 0xc3, 0x28]), { name: "a.txt" })
    ).toThrow(TelegramMediaError)
  })

  it("zipEntryNames đọc central directory, từ chối dữ liệu hỏng", () => {
    expect(zipEntryNames(DOCX)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
    ])
    expect(zipEntryNames(DOCX.subarray(0, DOCX.length - 30))).toBeNull()
    expect(zipEntryNames(Buffer.from("PK\x03\x04", "latin1"))).toBeNull()
  })
})

describe("resolveMediaKind (send_as)", () => {
  const t = (b: Buffer) => detectFileType(b, {})
  const big = TELEGRAM_PHOTO_MAX_BYTES + 1
  it.each<[Buffer, number, SendAs, string]>([
    [JPEG, 100, "auto", "photo"],
    [PNG, big, "auto", "document"],
    [GIF, 100, "auto", "document"],
    [WEBP, 100, "photo", "photo"],
    [JPEG, 100, "document", "document"],
    [MP4, 100, "auto", "video"],
    [MP4, 100, "document", "document"],
    [MOV, 100, "auto", "document"],
    [PDF, 100, "auto", "document"],
  ])("%# → %s", (b, size, sendAs, kind) => {
    expect(resolveMediaKind(t(b), size, sendAs)).toBe(kind)
  })

  it("send_as không khớp loại tệp → lỗi rõ ràng", () => {
    expect(
      mediaError(() => resolveMediaKind(t(PDF), 1, "photo")).userMessageVi
    ).toBe(m.media.notPhoto)
    expect(
      mediaError(() => resolveMediaKind(t(MOV), 1, "video")).userMessageVi
    ).toBe(m.media.notVideo)
    expect(mediaError(() => resolveMediaKind(t(JPEG), 1, "video")).code).toBe(
      "telegram_file_type_not_allowed"
    )
    const e = mediaError(() => resolveMediaKind(t(JPEG), big, "photo"))
    expect(e.code).toBe("telegram_file_too_large")
    expect(e.hintVi).toBe(m.media.sendAsHint)
  })
})

describe("sanitizeFileName", () => {
  const now = new Date("2026-10-09T07:30:00Z") // 14:30 in Vietnam
  it("NFC, bỏ ký tự điều khiển/đảo chiều/cấm, đuôi theo loại thật, ≤ 64 ký tự", () => {
    const nfd = "Bá»o cáo".normalize("NFD")
    expect(sanitizeFileName(`${nfd}.png`, "jpg", now)).toBe(
      `${"Bá»o cáo".normalize("NFC")}.jpg`
    )
    const rlo = String.fromCharCode(0x202e)
    const zw = String.fromCharCode(0x200b)
    expect(
      sanitizeFileName(`a${rlo}b${zw}c\u0007/d:e*f?g"h<i>j|k%l.pdf`, "pdf", now)
    ).toBe("abc d e f g h i j k l.pdf")
    const long = sanitizeFileName(`${"đ".repeat(100)}.docx`, "docx", now)
    expect(long).toBe(`${"đ".repeat(64)}.docx`)
    expect(sanitizeFileName("bao-cao", "csv", now)).toBe("bao-cao.csv")
  })

  it("rỗng / chỉ ký tự cấm → tep-<ngày giờ VN>", () => {
    expect(sanitizeFileName(null, "jpg", now)).toBe("tep-20261009-1430.jpg")
    expect(sanitizeFileName(" ../ ", "pdf", now)).toBe("tep-20261009-1430.pdf")
  })
})

describe("prepareAttachment: tệp chữ do AI viết", () => {
  const text = (content: string, fileName: string, sendAs: SendAs = "auto") =>
    prepareAttachment({ type: "text", content, fileName }, { sendAs })

  it("CSV: BOM UTF-8 + chống công thức + redact token; gửi dạng tệp", async () => {
    const r = await text(
      `Tên,Chi tiêu,Ghi chú\nQC A,-5,=HYPERLINK("x")\n"@cmd",+84901,${TG_TOKEN}\n`,
      "Báo cáo.csv"
    )
    expect(r.kind).toBe("document")
    expect(r.mime).toBe("text/csv")
    expect(r.fileName).toBe("Báo cáo.csv")
    const s = r.bytes.toString("utf8")
    expect(s.startsWith(BOM)).toBe(true)
    expect(s).toContain(`QC A,-5,'=HYPERLINK("x")`)
    expect(s).toContain(`"'@cmd",+84901,`)
    expect(s).not.toContain(TG_TOKEN.slice(12))
    expect(r.sizeBytes).toBe(r.bytes.length)
  })

  it("neutralizeFormulas: = @ tab CR, +/- không phải số; ô có ngoặc kép, nhiều dòng", () => {
    expect(neutralizeFormulas("=1+1,@x,+84123,-5,-x,+,abc")).toBe(
      "'=1+1,'@x,+84123,-5,'-x,'+,abc"
    )
    expect(neutralizeFormulas('"=a,b",x\n"y ""q""",-z')).toBe(
      `"'=a,b",x\n"y ""q""",'-z`
    )
    expect(neutralizeFormulas("a\t=b\n@c\td")).toBe("a\t'=b\n'@c\td")
    expect(neutralizeFormulas("a,,b\r\n,c")).toBe("a,,b\r\n,c")
    expect(neutralizeFormulas("")).toBe("")
  })

  it("neutralizeFormulas: , ; tab CR LF đều là ranh giới ô dù tệp dùng dấu phân cách nào (Excel VN tách theo ;, en-US theo ,)", () => {
    // a ","-file opened by Vietnamese Excel (";") and a ";"-file opened by en-US Excel (",")
    expect(neutralizeFormulas("ten,ghi chu;=cmd|' /C calc'!A0")).toBe(
      "ten,ghi chu;'=cmd|' /C calc'!A0"
    )
    expect(neutralizeFormulas("a;b,@SUM(1)\n1;2")).toBe("a;b,'@SUM(1)\n1;2")
    // inside quotes , ; are text, the cell starts after the opening quote
    expect(neutralizeFormulas('"x;=1",y')).toBe('"x;=1",y')
    expect(neutralizeFormulas('a;"=1;2"')).toBe(`a;"'=1;2"`)
  })

  it("neutralizeFormulas: +/- chỉ được giữ khi CẢ ô là số thuần (+84901, -5, 1.234,5, -12%, có khoảng trắng)", () => {
    expect(neutralizeFormulas("-1+cmd|' /C calc'!A0")).toBe(
      "'-1+cmd|' /C calc'!A0"
    )
    expect(neutralizeFormulas('+0+WEBSERVICE("http://x")')).toBe(
      `'+0+WEBSERVICE("http://x")`
    )
    expect(neutralizeFormulas("-2-HYPERLINK(1)\t+1)")).toBe(
      "'-2-HYPERLINK(1)\t'+1)"
    )
    expect(neutralizeFormulas('"-1+cmd"')).toBe(`"'-1+cmd"`)
    expect(neutralizeFormulas(" =1")).toBe("' =1")
    for (const n of ["+84901", "-5", " -5 ", "-12%", "+1.5", '"-1,234.5"']) {
      expect(neutralizeFormulas(n)).toBe(n)
    }
    // in a ","-file "1.234,5" is two cells: 1.234 and 5 (both plain)
    expect(neutralizeFormulas("-1.234,5")).toBe("-1.234,5")
  })

  it("neutralizeFormulas: CR đơn lẻ mở ô / dòng mới; ô có ngoặc kép bắt đầu bằng tab / CR / LF bị chặn", () => {
    expect(neutralizeFormulas("a\r=b\r@c")).toBe("a\r'=b\r'@c")
    expect(neutralizeFormulas("a\r\r-x")).toBe("a\r\r'-x")
    expect(neutralizeFormulas('"\r=x",b')).toBe(`"'\r=x",b`)
    expect(neutralizeFormulas('"\tx"')).toBe(`"'\tx"`)
  })

  it("CSV phân tách bằng ; (Excel tiếng Việt) và TSV", async () => {
    const semi = await text("a;b\n=1;2", "x.csv")
    expect(semi.bytes.toString("utf8")).toBe(`${BOM}a;b\n'=1;2`)
    const tsv = await text("a\tb\n@x\t1", "x.tsv")
    expect(tsv.bytes.toString("utf8")).toBe(`${BOM}a\tb\n'@x\t1`)
    expect(tsv.mime).toBe("text/tab-separated-values")
  })

  it("TXT/MD/JSON giữ nguyên (chỉ redact), không BOM", async () => {
    const r = await text("=không phải công thức", "ghi-chu.md")
    expect(r.bytes.toString("utf8")).toBe("=không phải công thức")
    expect(r.mime).toBe("text/markdown")
  })

  it("lỗi: đuôi không hỗ trợ, rỗng, NUL, > 256 KB, send_as photo/video", async () => {
    expect((await mediaErrorAsync(text("x", "a.html"))).userMessageVi).toBe(
      m.media.textExtension
    )
    expect((await mediaErrorAsync(text("x", "khong-duoi"))).code).toBe(
      "telegram_file_type_not_allowed"
    )
    expect((await mediaErrorAsync(text("  ", "a.txt"))).code).toBe(
      "telegram_file_invalid"
    )
    expect(
      (await mediaErrorAsync(text(`a${String.fromCharCode(0)}b`, "a.txt"))).code
    ).toBe("telegram_file_invalid")
    const big = await mediaErrorAsync(
      text("x".repeat(TELEGRAM_TEXT_FILE_MAX_BYTES + 1), "a.txt")
    )
    expect(big.code).toBe("telegram_file_too_large")
    expect(big.userMessageVi).toBe(m.media.textTooLarge)
    expect((await mediaErrorAsync(text("x", "a.csv", "photo"))).code).toBe(
      "telegram_file_type_not_allowed"
    )
    expect((await mediaErrorAsync(text("x", "a.csv", "video"))).code).toBe(
      "telegram_file_type_not_allowed"
    )
  })
})

describe("prepareAttachment: tải qua fetch được inject", () => {
  const SECRET = "sig=SECRET123"
  const url = (path = "/files/b%C3%A1o-c%C3%A1o.jpg") =>
    `https://cdn.example.com${path}?${SECRET}`
  const body = (
    b: Buffer,
    headers: Record<string, string> = {},
    status = 200
  ) => new Response(new Uint8Array(b), { status, headers })

  function noUrlLeak(e: TelegramMediaError) {
    for (const s of [e.message, e.userMessageVi, e.hintVi ?? ""]) {
      expect(s).not.toContain("SECRET123")
      expect(s).not.toContain("cdn.example.com")
    }
  }

  it("link ảnh https → photo, tên lấy từ path (decode), không theo redirect tự động", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      body(JPEG, { "content-type": "application/octet-stream" })
    )
    const r = await prepareAttachment(
      { type: "url", url: url() },
      { sendAs: "auto", fetchImpl: f }
    )
    expect(r).toMatchObject({
      kind: "photo",
      fileName: "báo-cáo.jpg",
      mime: "image/jpeg",
      sizeBytes: JPEG.length,
    })
    expect(f.mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
      method: "GET",
    })
  })

  it("tệp ChatGPT: dùng download_url, tên/mime từ descriptor (CSV)", async () => {
    const f = vi.fn<typeof fetch>(async () => body(Buffer.from("a,b\n=1,2")))
    const src: AttachmentSource = {
      type: "chatgpt",
      downloadUrl: "https://files.oaiusercontent.com/file-abc?sig=SECRET123",
      fileId: "file-abc",
      mimeType: "text/csv",
      fileName: "du-lieu",
    }
    const r = await prepareAttachment(src, { sendAs: "auto", fetchImpl: f })
    expect(r).toMatchObject({
      kind: "document",
      fileName: "du-lieu.csv",
      mime: "text/csv",
    })
    // a downloaded file is sent as it is (no rewrite)
    expect(r.bytes.toString("utf8")).toBe("a,b\n=1,2")
    expect(String(f.mock.calls[0]![0])).toBe(src.downloadUrl)
  })

  it("chặn http, địa chỉ nội bộ, IP riêng, thông tin đăng nhập - không gọi fetch", async () => {
    const f = vi.fn<typeof fetch>()
    for (const u of [
      "http://cdn.example.com/a.jpg",
      "https://localhost/a.jpg",
      "https://127.0.0.1/a.jpg",
      "https://[::1]/a.jpg",
      "https://169.254.169.254/latest",
      "https://user:pw@cdn.example.com/a.jpg",
      "https://svc.internal/a.jpg",
      "file:///etc/passwd",
    ]) {
      const e = await mediaErrorAsync(
        prepareAttachment(
          { type: "url", url: u },
          { sendAs: "auto", fetchImpl: f }
        )
      )
      expect(e.code).toBe("url_not_allowed")
      expect(e.userMessageVi).not.toContain(u)
    }
    expect(f).not.toHaveBeenCalled()
  })

  it("redirect: kiểm tra lại từng bước (sang http / nội bộ bị chặn), tối đa 3 lần", async () => {
    const redirect = (location: string) =>
      new Response(null, { status: 302, headers: { location } })
    const toInternal = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("https://10.0.0.5/x.jpg"))
    expect(
      (
        await mediaErrorAsync(
          prepareAttachment(
            { type: "url", url: url() },
            { sendAs: "auto", fetchImpl: toInternal }
          )
        )
      ).code
    ).toBe("url_not_allowed")
    const toHttp = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("http://cdn.example.com/x"))
    expect(
      (
        await mediaErrorAsync(
          prepareAttachment(
            { type: "url", url: url() },
            { sendAs: "auto", fetchImpl: toHttp }
          )
        )
      ).code
    ).toBe("url_not_allowed")
    const loop = vi.fn<typeof fetch>(async () => redirect("/again"))
    const e = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url() },
        { sendAs: "auto", fetchImpl: loop }
      )
    )
    expect(e.code).toBe("telegram_file_fetch_failed")
    expect(e.userMessageVi).toBe(m.media.tooManyRedirects)
    expect(loop).toHaveBeenCalledTimes(4)
    const ok = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("/real/anh.png"))
      .mockResolvedValueOnce(body(PNG))
    const r = await prepareAttachment(
      { type: "url", url: url() },
      { sendAs: "auto", fetchImpl: ok }
    )
    expect(r.kind).toBe("photo")
    expect(String(ok.mock.calls[1]![0])).toBe(
      "https://cdn.example.com/real/anh.png"
    )
  })

  it("HTTP lỗi, rỗng, quá 50 MB (khai báo hoặc khi đang tải) - thông điệp không chứa URL", async () => {
    const e404 = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url() },
        {
          sendAs: "auto",
          fetchImpl: async () => body(Buffer.from("no"), {}, 404),
        }
      )
    )
    expect(e404.code).toBe("telegram_file_fetch_failed")
    expect(e404.userMessageVi).toBe(m.media.fetchFailedStatus(404))
    noUrlLeak(e404)
    const empty = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url() },
        { sendAs: "auto", fetchImpl: async () => body(Buffer.alloc(0)) }
      )
    )
    expect(empty.code).toBe("telegram_file_invalid")
    const declared = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url() },
        {
          sendAs: "auto",
          fetchImpl: async () =>
            body(JPEG, {
              "content-length": String(TELEGRAM_UPLOAD_MAX_BYTES + 1),
            }),
        }
      )
    )
    expect(declared.code).toBe("telegram_file_too_large")
    const chunk = new Uint8Array(4 * 1024 * 1024)
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += chunk.length
        c.enqueue(chunk)
      },
    })
    const streamed = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url() },
        { sendAs: "auto", fetchImpl: async () => new Response(endless) }
      )
    )
    expect(streamed.code).toBe("telegram_file_too_large")
    expect(sent).toBeLessThanOrEqual(
      TELEGRAM_UPLOAD_MAX_BYTES + 3 * chunk.length
    )
    noUrlLeak(streamed)
  })

  it("máy chủ treo (không phản hồi / ngừng gửi dữ liệu) → telegram_file_timeout", async () => {
    const hang = vi.fn<typeof fetch>(
      (_u, init) =>
        new Promise((_r, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        )
    )
    const total = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url() },
        {
          sendAs: "auto",
          fetchImpl: hang,
          timeouts: { totalMs: 30, idleMs: 5_000 },
        }
      )
    )
    expect(total.code).toBe("telegram_file_timeout")
    noUrlLeak(total)
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(JPEG))
      },
    })
    const idle = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url() },
        {
          sendAs: "auto",
          fetchImpl: async () => new Response(stalled),
          timeouts: { totalMs: 5_000, idleMs: 30 },
        }
      )
    )
    expect(idle.code).toBe("telegram_file_timeout")
  })

  it("loại tệp không được phép khi tải về (exe giả .jpg)", async () => {
    const e = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url("/a.jpg") },
        {
          sendAs: "auto",
          fetchImpl: async () =>
            body(Buffer.from("MZ\x90\x00", "latin1"), {
              "content-type": "image/jpeg",
            }),
        }
      )
    )
    expect(e.code).toBe("telegram_file_type_not_allowed")
  })

  it("Location không phân tích được → telegram_file_fetch_failed, không TypeError mang URL", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://[::1/x?sig=SECRET123" },
        })
      )
    const e = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: url() },
        { sendAs: "auto", fetchImpl: f }
      )
    )
    expect(e.code).toBe("telegram_file_fetch_failed")
    noUrlLeak(e)
  })

  it("setMediaFetchImpl chỉ dùng được trong test (NODE_ENV=test / VITEST)", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("VITEST", "")
    try {
      expect(() => setMediaFetchImpl(async () => body(PDF))).toThrow(
        "test-only"
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("setMediaFetchImpl thay downloader khi không truyền fetchImpl (test flows)", async () => {
    setMediaFetchImpl(async () => body(PDF))
    const r = await prepareAttachment(
      { type: "url", url: url("/a") },
      { sendAs: "auto" }
    )
    expect(r).toMatchObject({ kind: "document", fileName: "a.pdf" })
    expect(safeFetch).not.toHaveBeenCalled()
    // file_name wins over the URL path; the extension follows the sniffed type
    const named = await prepareAttachment(
      { type: "url", url: url("/a"), fileName: "Hợp đồng.docx" },
      { sendAs: "auto" }
    )
    expect(named.fileName).toBe("Hợp đồng.pdf")
  })
})

describe("prepareAttachment: đường production (safeFetch, mock)", () => {
  const sf = vi.mocked(safeFetch)

  it("https-only, ≤ 50 MB, idle 10 s, tổng 25 s, ≤ 3 redirect", async () => {
    sf.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "video/mp4" },
      finalUrl: "https://cdn.example.com/v.mp4",
      body: MP4,
    })
    const r = await prepareAttachment(
      { type: "url", url: "https://cdn.example.com/v.mp4?token=abc" },
      { sendAs: "auto" }
    )
    expect(r).toMatchObject({
      kind: "video",
      fileName: "v.mp4",
      mime: "video/mp4",
    })
    expect(sf).toHaveBeenCalledWith(
      "https://cdn.example.com/v.mp4?token=abc",
      expect.objectContaining({
        method: "GET",
        readBody: true,
        httpsOnly: true,
        maxBytes: TELEGRAM_UPLOAD_MAX_BYTES,
        timeoutMs: 10_000,
        totalTimeoutMs: 25_000,
        maxRedirects: 3,
      })
    )
  })

  it("map lỗi guard (McpToolError) sang TelegramMediaError", async () => {
    const cases: [Error, string][] = [
      [
        invalid("url_not_allowed", "URL không được phép: địa chỉ IP nội bộ"),
        "url_not_allowed",
      ],
      [invalid("media_too_large", "x"), "telegram_file_too_large"],
      [invalid("media_timeout", "x"), "telegram_file_timeout"],
      [invalid("too_many_redirects", "x"), "telegram_file_fetch_failed"],
      [invalid("media_fetch_failed", "x"), "telegram_file_fetch_failed"],
      [
        new Error("socket hang up https://cdn.example.com/?sig=SECRET123"),
        "telegram_file_fetch_failed",
      ],
    ]
    for (const [thrown, code] of cases) {
      sf.mockRejectedValueOnce(thrown)
      const e = await mediaErrorAsync(
        prepareAttachment(
          { type: "url", url: "https://cdn.example.com/a.jpg" },
          { sendAs: "auto" }
        )
      )
      expect(e.code).toBe(code)
      expect(e.userMessageVi).not.toContain("SECRET123")
    }
    sf.mockRejectedValueOnce(
      invalid("url_not_allowed", "URL không được phép: địa chỉ IP nội bộ")
    )
    const e = await mediaErrorAsync(
      prepareAttachment(
        { type: "url", url: "https://cdn.example.com/a.jpg" },
        { sendAs: "auto" }
      )
    )
    expect(e.userMessageVi).toBe("URL không được phép: địa chỉ IP nội bộ")
    expect(e.hintVi).toBe(m.media.errors.url_not_allowed.hint)
  })

  it("assertPublicUrlSyntax: httpsOnly là tuỳ chọn (mặc định vẫn cho http như cũ)", () => {
    expect(assertPublicUrlSyntax("http://example.com/a").url.protocol).toBe(
      "http:"
    )
    expect(() =>
      assertPublicUrlSyntax("http://example.com/a", { httpsOnly: true })
    ).toThrow(/https/)
    expect(assertPublicUrlSyntax("https://8.8.8.8/a").ipLiteral).toBe(true)
  })
})

describe("withMediaSlot", () => {
  it("tối đa 2 lượt đồng thời; lượt thứ 3 chờ rồi chạy khi có chỗ", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let running = 0
    let peak = 0
    const job = () =>
      withMediaSlot(async () => {
        running++
        peak = Math.max(peak, running)
        await gate
        running--
        return "ok"
      })
    const all = Promise.all([job(), job(), job()])
    await new Promise((r) => setTimeout(r, 10))
    expect(running).toBe(MEDIA_SLOTS.concurrent)
    release()
    expect(await all).toEqual(["ok", "ok", "ok"])
    expect(peak).toBe(2)
  })

  it("chờ quá 5 s → telegram_busy; lỗi trong fn vẫn trả chỗ", async () => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const holders = [withMediaSlot(() => gate), withMediaSlot(() => gate)]
    const waiting = withMediaSlot(async () => "late")
    const settled = waiting.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(MEDIA_SLOTS.waitMs + 1)
    const e = await settled
    expect(isTelegramMediaError(e) && e.code).toBe("telegram_busy")
    release()
    await Promise.all(holders)
    await expect(
      withMediaSlot(async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    expect(await withMediaSlot(async () => 1)).toBe(1)
    expect(await withMediaSlot(async () => 2)).toBe(2)
  })

  it("key (MCP): 1 lượt / key - lượt thứ 2 cùng key bị từ chối ngay (telegram_busy, đang gửi tệp khác); key khác vẫn chạy", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const first = withMediaSlot(() => gate.then(() => "a"), { key: "mcp-1" })
    const admit = vi.fn(async () => {})
    const e = await withMediaSlot(async () => "b", { key: "mcp-1", admit })
      .then(() => null)
      .catch((x: unknown) => x)
    expect(isTelegramMediaError(e) && e.code).toBe("telegram_busy")
    expect(isTelegramMediaError(e) && e.userMessageVi).toBe(m.media.busyMcp)
    // refused before admit: a busy call is not counted
    expect(admit).not.toHaveBeenCalled()
    expect(await withMediaSlot(async () => "c", { key: "mcp-2" })).toBe("c")
    release()
    expect(await first).toBe("a")
    // the key is free again once the job ended
    expect(await withMediaSlot(async () => "d", { key: "mcp-1", admit })).toBe(
      "d"
    )
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it("admit chạy trước khi chờ slot; admit ném lỗi → không chạy fn, key được trả", async () => {
    const fn = vi.fn(async () => "x")
    await expect(
      withMediaSlot(fn, {
        key: "mcp-3",
        admit: async () => {
          throw new Error("limited")
        },
      })
    ).rejects.toThrow("limited")
    expect(fn).not.toHaveBeenCalled()
    expect(await withMediaSlot(fn, { key: "mcp-3" })).toBe("x")
  })
})

describe("mediaPreviewLabel / formatFileSize", () => {
  it("nhãn preview tiếng Việt", () => {
    expect(
      mediaPreviewLabel({
        kind: "photo",
        fileName: "a.jpg",
        sizeBytes: Math.round(1.2 * 1024 * 1024),
      })
    ).toBe("[Ảnh: a.jpg · 1,2 MB]")
    expect(
      mediaPreviewLabel({
        kind: "video",
        fileName: "v.mp4",
        sizeBytes: 350 * 1024,
      })
    ).toBe("[Video: v.mp4 · 350 KB]")
    expect(
      mediaPreviewLabel({ kind: "document", fileName: "b.pdf", sizeBytes: 900 })
    ).toBe("[Tệp: b.pdf · 900 B]")
    expect(formatFileSize(1536)).toBe("1,5 KB")
  })
})
