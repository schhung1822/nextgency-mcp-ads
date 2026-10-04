import { describe, expect, it } from "vitest"

import { formatIp } from "./format-ip"

describe("formatIp", () => {
  it("giữ nguyên IPv4", () => {
    expect(formatIp("203.0.113.7")).toBe("203.0.113.7")
  })

  it("rút gọn IPv6 đầy đủ", () => {
    expect(formatIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1")
    expect(formatIp("fe80:0000:0000:0000:0202:b3ff:fe1e:8329")).toBe("fe80::202:b3ff:fe1e:8329")
  })

  it("không nén một nhóm 0 đơn lẻ", () => {
    expect(formatIp("2001:db8:0:1:1:1:1:1")).toBe("2001:db8:0:1:1:1:1:1")
  })

  it("địa chỉ toàn số 0 hoặc rỗng → null (hiển thị 'Không rõ IP')", () => {
    expect(formatIp("0000:0000:0000:0000:0000:0000:0000:0000")).toBeNull()
    expect(formatIp("::")).toBeNull()
    expect(formatIp("")).toBeNull()
    expect(formatIp(null)).toBeNull()
  })

  it("giữ nguyên dạng đã rút gọn / IPv4-mapped", () => {
    expect(formatIp("::1")).toBe("::1")
    expect(formatIp("::ffff:1.2.3.4")).toBe("::ffff:1.2.3.4")
  })
})
