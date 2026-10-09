// Drive / Docs link parsing: every observed format, resourcekey (any case), #gid=, documents, bad input.
import { describe, expect, it } from "vitest"

import { isDriveId, isGoogleDriveUrl, parseDriveLink } from "./links"

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"
const FOLDER = "0B_folder-ID_abcdefghij"

describe("parseDriveLink", () => {
  it.each([
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`, "file"],
    [`https://drive.google.com/file/d/${ID}`, "file"],
    [`https://drive.google.com/file/u/1/d/${ID}/view`, "file"],
    [`https://drive.google.com/uc?id=${ID}&export=download`, "file"],
    [`https://drive.google.com/uc?export=download&id=${ID}`, "file"],
    [
      `https://drive.usercontent.google.com/download?id=${ID}&export=download&authuser=0`,
      "file",
    ],
    [
      `https://drive.usercontent.google.com/u/0/uc?id=${ID}&export=download`,
      "file",
    ],
    [`https://drive.google.com/open?id=${ID}`, "unknown"],
    [`http://drive.google.com/file/d/${ID}/view`, "file"],
  ])("file: %s", (url, kind) => {
    expect(parseDriveLink(url)).toEqual({
      kind,
      id: ID,
      resourceKey: null,
      gid: null,
    })
  })

  it.each([
    `https://drive.google.com/drive/folders/${FOLDER}`,
    `https://drive.google.com/drive/folders/${FOLDER}?usp=drive_link`,
    `https://drive.google.com/drive/u/0/folders/${FOLDER}`,
    `https://drive.google.com/drive/u/2/folders/${FOLDER}/`,
    `https://drive.google.com/drive/mobile/folders/${FOLDER}`,
    `https://drive.google.com/folderview?id=${FOLDER}`,
  ])("folder: %s", (url) => {
    expect(parseDriveLink(url)).toEqual({
      kind: "folder",
      id: FOLDER,
      resourceKey: null,
      gid: null,
    })
  })

  it("resourcekey (mọi kiểu chữ) được tách riêng", () => {
    expect(
      parseDriveLink(
        `https://drive.google.com/file/d/${ID}/view?resourcekey=0-AbC_d-123`
      )?.resourceKey
    ).toBe("0-AbC_d-123")
    expect(
      parseDriveLink(
        `https://drive.google.com/drive/folders/${FOLDER}?resourceKey=0-xyz`
      )
    ).toEqual({
      kind: "folder",
      id: FOLDER,
      resourceKey: "0-xyz",
      gid: null,
    })
    expect(
      parseDriveLink(`https://drive.google.com/uc?id=${ID}&RESOURCEKEY=0-k`)
        ?.resourceKey
    ).toBe("0-k")
    // a resource key with odd characters is dropped, not passed to Google
    expect(
      parseDriveLink(
        `https://drive.google.com/file/d/${ID}/view?resourcekey=a%2Fb`
      )?.resourceKey
    ).toBeNull()
  })

  it("Google Sheet: id + gid (hash hoặc query)", () => {
    expect(
      parseDriveLink(
        `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=123456`
      )
    ).toEqual({
      kind: "sheet",
      id: ID,
      resourceKey: null,
      gid: 123456,
    })
    expect(
      parseDriveLink(
        `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=0#gid=0`
      )?.gid
    ).toBe(0)
    expect(
      parseDriveLink(
        `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=77&range=A1`
      )?.gid
    ).toBe(77)
    expect(
      parseDriveLink(`https://docs.google.com/spreadsheets/u/0/d/${ID}/edit`)
    ).toEqual({
      kind: "sheet",
      id: ID,
      resourceKey: null,
      gid: null,
    })
    expect(
      parseDriveLink(
        `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=99999999999`
      )?.gid
    ).toBeNull()
  })

  it("Docs / Slides / Forms → document", () => {
    for (const app of ["document", "presentation", "forms", "drawings"])
      expect(
        parseDriveLink(`https://docs.google.com/${app}/d/${ID}/edit`)?.kind
      ).toBe("document")
  })

  it("mã trần → unknown", () => {
    expect(parseDriveLink(`  ${ID} `)).toEqual({
      kind: "unknown",
      id: ID,
      resourceKey: null,
      gid: null,
    })
  })

  it.each([
    "",
    "short",
    "https://example.com/file/d/1AbCdEfGhIjKlMnOp/view",
    "https://drive.google.com.evil.com/file/d/1AbCdEfGhIjKlMnOp/view",
    "https://evil.com/?u=https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp",
    "ftp://drive.google.com/file/d/1AbCdEfGhIjKlMnOp",
    "javascript:alert(1)",
    "https://user:pass@drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view",
    "https://drive.google.com/file/d/short/view",
    "https://drive.google.com/file/d/../../etc/view",
    "https://drive.google.com/drive/my-drive",
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vXYZ/pubhtml",
    "https://drive.google.com/uc?export=download",
    "1AbCdEf GhIjKlMnOp",
    `https://drive.google.com/file/d/${"a".repeat(3000)}`,
  ])("không hợp lệ: %s", (input) => {
    expect(parseDriveLink(input)).toBeNull()
  })
})

describe("isGoogleDriveUrl / isDriveId", () => {
  it("chỉ host Drive / Docs", () => {
    expect(isGoogleDriveUrl(`https://drive.google.com/file/d/${ID}/view`)).toBe(
      true
    )
    expect(isGoogleDriveUrl("https://docs.google.com/spreadsheets/d/x")).toBe(
      true
    )
    expect(
      isGoogleDriveUrl("https://drive.usercontent.google.com/download?id=x")
    ).toBe(true)
    expect(isGoogleDriveUrl("https://example.com/a.jpg")).toBe(false)
    expect(isGoogleDriveUrl("https://drive.google.com.evil.com/x")).toBe(false)
    expect(isGoogleDriveUrl(ID)).toBe(false)
    expect(isGoogleDriveUrl("not a url")).toBe(false)
  })
  it("isDriveId", () => {
    expect(isDriveId(ID)).toBe(true)
    expect(isDriveId("short")).toBe(false)
    expect(isDriveId("abc/../defghijk")).toBe(false)
  })
})
