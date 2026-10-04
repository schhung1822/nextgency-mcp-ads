// DEV ONLY — UI audit helper: logs in with a seeded session cookie, visits routes at several viewports
// and themes, saves screenshots and reports console errors/warnings, horizontal overflow, tiny touch
// targets and basic a11y smells (unnamed buttons/links/inputs, images without alt, heading jumps).
//
//   node scripts/ui-shots.mjs --cookies path/to/cookies.json --out path/to/dir \
//        [--base http://localhost:3111] [--role admin|staff] \
//        [--routes "/,/logs,/settings"] [--viewports desktop,tablet,mobile] [--themes light,dark] \
//        [--reduced-transparency] [--no-full] [--max-height 2400]
//
// cookies.json: { "admin": "better-auth.session_token=…", "staff": "…" } (as written by
// `scripts/dev-seed-logs.ts --out`). Never commit that file.
//
// A route may carry a scene after "#" — an interaction performed before the screenshot, e.g.
//   /logs#export   /#palette   /#search   /#search-type   /#usermenu   /#sidebar   /logs#detail   /logs#staff-tab
// Add scenes to SCENES below. Viewports: laptop 1280x800, desktop 1440x900, wide 1920x1080, tablet 820x1180,
// mobile 390x844, small 360x740 (override with --viewports name,name).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { chromium } from "@playwright/test"

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def
}
const flag = (name) => args.includes(`--${name}`)

const BASE = opt("base", "http://localhost:3111")
const ROLE = opt("role", "admin")
const OUT = opt("out", "ui-shots")
const COOKIES = opt("cookies", null)
const ROUTES = opt("routes", "/,/logs,/settings").split(",").map((s) => s.trim()).filter(Boolean)
const THEMES = opt("themes", "light,dark").split(",")
const FULL = !flag("no-full")
const REDUCED = flag("reduced-transparency")
const MAX_H = Number(opt("max-height", "2400")) // css px — long tables are cropped so screenshots stay readable

const VIEWPORTS = {
  laptop: { width: 1280, height: 800, deviceScaleFactor: 1, hasTouch: false },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, hasTouch: false },
  wide: { width: 1920, height: 1080, deviceScaleFactor: 1, hasTouch: false },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 1, hasTouch: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true },
  small: { width: 360, height: 740, deviceScaleFactor: 2, hasTouch: true },
}
const VPS = opt("viewports", "desktop,tablet,mobile").split(",")

const TRANSPARENCY_KEY = "ads-mcp:transparency"

// phones: icon button (aria-label); md+: the wide search field in the top bar
async function openSearch(page, vp) {
  const btn =
    vp.width < 768
      ? page.getByRole("button", { name: "Mở tìm kiếm nhanh" })
      : page.locator("header button:visible", { hasText: "Gõ để tìm trang" })
  await btn.first().click()
}

/** scene name -> async (page, vp) => void; runs after load, before the screenshot. */
const SCENES = {
  async palette(page) {
    await page.keyboard.press("Control+k")
    await page.waitForTimeout(400)
  },
  // < lg: palette is an 80% bottom sheet opened from the top bar search button; "search-type" also types a query
  async search(page, vp) {
    await openSearch(page, vp)
    await page.waitForTimeout(700)
  },
  async "search-type"(page, vp) {
    await openSearch(page, vp)
    await page.waitForTimeout(500)
    await page.getByRole("combobox", { name: "Tìm nhanh" }).fill("nhật")
    await page.waitForTimeout(400)
  },
  async usermenu(page, vp) {
    const trigger =
      vp.width < 768
        ? page.locator("header button[aria-haspopup='menu']").last()
        : page.locator("[data-slot='sidebar-footer'] button[aria-haspopup='menu']").first()
    await trigger.click()
    await page.waitForTimeout(400)
  },
  async thememenu(page) {
    await page.getByRole("button", { name: /giao diện|chế độ/i }).first().click()
    await page.waitForTimeout(400)
  },
  async sidebar(page, vp) {
    if (vp.width < 768) {
      await page.locator("[data-sidebar='trigger']").first().click()
      await page.waitForTimeout(500)
    }
  },
  async detail(page) {
    // first visible row: table row (md+) or mobile card button
    await page.locator("tbody tr:visible, ul[aria-label] li > button:visible").first().click()
    await page.waitForTimeout(900)
  },
  async export(page) {
    await page.getByRole("button", { name: /xuất/i }).first().click()
    await page.waitForTimeout(500)
  },
  async collapse(page) {
    await page.locator("[data-sidebar='trigger']").first().click()
    await page.waitForTimeout(500)
  },
  // Guide panel / sheet / bottom bar scenes (ui-shell-v2)
  async "guide-collapse"(page) {
    await page.getByRole("button", { name: "Thu gọn", exact: true }).first().click()
    await page.waitForTimeout(500)
  },
  async bottom(page) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(400)
  },
  async "guide-sheet"(page) {
    await page.getByRole("button", { name: "Mở hướng dẫn" }).first().click()
    await page.waitForTimeout(700)
  },
  async menu(page) {
    await page.getByRole("button", { name: "Menu", exact: true }).click()
    await page.waitForTimeout(700)
  },
  async dialog(page) {
    // opens the first "Tạo người dùng"/"Thêm người dùng" style dialog trigger, else the rename dialog
    const trigger = page.getByRole("button", { name: /thêm người dùng|đổi tên|xoá kết nối/i }).first()
    await trigger.click()
    await page.waitForTimeout(700)
  },
  async daterange(page) {
    await page.getByRole("button", { name: /khoảng thời gian/i }).first().click()
    await page.waitForTimeout(600)
  },
  async pill(page) {
    await page.getByRole("button", { name: /nền tảng/i }).first().click()
    await page.waitForTimeout(500)
  },
  async "staff-tab"(page) {
    await page.getByRole("tab", { name: /nhân sự/i }).click()
    await page.waitForTimeout(800)
  },
  async dirty(page) {
    // settings: change a number input to reveal the contextual save bar
    const input = page.locator("input[type='number'], input[inputmode='numeric']").first()
    await input.fill("7")
    await page.waitForTimeout(500)
  },
  async invalid(page) {
    const input = page.locator("input[type='number'], input[inputmode='numeric']").first()
    await input.fill("999")
    await input.blur()
    await page.waitForTimeout(500)
  },
}

function slug(route) {
  return route.replace(/^\//, "").replace(/[\/#?=&,]+/g, "_") || "home"
}

/** Runs inside the page: returns structural findings. */
function pageAudit() {
  const out = { overflow: null, wide: [], smallTargets: [], unnamed: [], imgNoAlt: 0, headings: [], title: document.title, lang: document.documentElement.lang }
  const de = document.documentElement
  if (de.scrollWidth > window.innerWidth + 1) out.overflow = { scrollWidth: de.scrollWidth, innerWidth: window.innerWidth }
  const vw = window.innerWidth
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX
      if ((o === "auto" || o === "scroll" || o === "hidden" || o === "clip") && p.clientWidth < p.scrollWidth + 1 && p.getBoundingClientRect().right <= vw + 1) return true
    }
    return false
  }
  const sel = (el) => {
    const slot = el.getAttribute("data-slot")
    const cls = (el.className && typeof el.className === "string" ? el.className : "").split(/\s+/).slice(0, 4).join(".")
    return `${el.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}${cls ? "." + cls : ""}`
  }
  if (out.overflow) {
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > vw + 1 && !inScroller(el)) out.wide.push({ el: sel(el), right: Math.round(r.right), width: Math.round(r.width) })
      if (out.wide.length >= 6) break
    }
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"
  }
  const nameOf = (el) =>
    (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.textContent || el.getAttribute("title") || el.querySelector("img[alt]")?.getAttribute("alt") || "").trim()
  for (const el of document.querySelectorAll("button, a[href], [role='button'], [role='tab'], input:not([type=hidden]), select, textarea, [role='switch'], [role='checkbox']")) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    const tag = el.tagName.toLowerCase()
    const isField = tag === "input" || tag === "select" || tag === "textarea"
    const labelled = () =>
      el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
      el.closest("label")
    if (el.closest("[aria-hidden='true']")) continue // e.g. the hidden checkbox behind a Radix Switch
    if (isField || el.getAttribute("role") === "switch" || el.getAttribute("role") === "checkbox") {
      if (!labelled() && !nameOf(el)) out.unnamed.push({ el: sel(el), type: el.getAttribute("type") || el.getAttribute("role") || tag })
    } else if (!nameOf(el)) {
      out.unnamed.push({ el: sel(el), href: el.getAttribute("href") || undefined })
    }
    if (r.width > 2 && r.height > 2 && r.height < 36 && r.width < 400) out.smallTargets.push({ el: sel(el), name: nameOf(el).slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) })
  }
  out.imgNoAlt = [...document.querySelectorAll("img:not([alt])")].length
  let last = 0
  for (const h of document.querySelectorAll("h1,h2,h3,h4")) {
    if (!visible(h)) continue
    const lvl = Number(h.tagName[1])
    out.headings.push(lvl)
    if (last && lvl > last + 1) out.unnamed.push({ el: `heading jump h${last}→h${lvl}`, text: h.textContent?.slice(0, 40) })
    last = lvl
  }
  return out
}

/** Runs inside the page, phones only: scrolls to the bottom and lists content that sits under the fixed bottom bar. */
function bottomBarAudit() {
  const nav = document.querySelector("[data-slot='bottom-nav']")
  if (!nav || getComputedStyle(nav).display === "none") return null
  window.scrollTo(0, document.documentElement.scrollHeight)
  const nr = nav.getBoundingClientRect()
  const covered = []
  for (const el of document.querySelectorAll("main :is(button, a[href], input, p, h1, h2, h3, td, label, li, [role=tab])")) {
    if (nav.contains(el) || el.closest("[data-slot='bottom-nav']")) continue
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width < 2 || r.height < 2 || cs.visibility === "hidden" || cs.display === "none") continue
    if (r.bottom > nr.top + 1 && r.top < nr.bottom - 1) covered.push((el.textContent || el.tagName).trim().slice(0, 40))
    if (covered.length >= 5) break
  }
  const main = document.querySelector("main")
  const mainBottom = main ? main.getBoundingClientRect().bottom : 0
  return { navTop: Math.round(nr.top), navHeight: Math.round(nr.height), covered, mainBottomVsNavTop: Math.round(mainBottom - nr.top), scrollbar: false }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const cookies = COOKIES ? JSON.parse(readFileSync(COOKIES, "utf8")) : {}
  const cookie = cookies[ROLE]
  const browser = await chromium.launch()
  const report = []
  for (const themeName of THEMES) {
    for (const vpName of VPS) {
      const vp = VIEWPORTS[vpName]
      if (!vp) throw new Error(`Unknown viewport ${vpName}`)
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor,
        hasTouch: vp.hasTouch,
        isMobile: vp.width < 600,
        locale: "vi-VN",
        timezoneId: "Asia/Ho_Chi_Minh",
        colorScheme: themeName === "dark" ? "dark" : "light",
      })
      if (cookie) {
        const [name, ...rest] = cookie.split("=")
        await context.addCookies([{ name, value: rest.join("="), url: BASE }])
      }
      await context.addInitScript(
        ([theme, reduced, key]) => {
          try {
            localStorage.setItem("theme", theme)
            if (reduced) localStorage.setItem(key, "reduced")
          } catch {}
        },
        [themeName, REDUCED, TRANSPARENCY_KEY]
      )
      for (const entry of ROUTES) {
        const [route, scene] = entry.split("#")
        const page = await context.newPage()
        const logs = []
        page.on("console", (m) => {
          if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text().slice(0, 300)}`)
        })
        page.on("pageerror", (e) => logs.push(`pageerror: ${String(e.message).slice(0, 300)}`))
        page.on("response", (r) => {
          if (r.status() >= 400 && !r.url().includes("favicon")) logs.push(`http ${r.status()}: ${new URL(r.url()).pathname}`)
        })
        let nav = null
        try {
          nav = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 60_000 })
        } catch (e) {
          logs.push(`navigation: ${String(e.message).slice(0, 200)}`)
        }
        // hide the Next.js dev indicator (round "N" badge) so it does not pollute screenshots
        await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {})
        await page.waitForTimeout(1800) // charts (recharts animates ~1.5s) / fonts
        if (scene) {
          try {
            await SCENES[scene](page, vp)
          } catch (e) {
            logs.push(`scene ${scene} failed: ${String(e.message).split("\n")[0]}`)
          }
        }
        const audit = await page.evaluate(pageAudit)
        const file = path.join(OUT, `${slug(entry)}__${vpName}__${themeName}${REDUCED ? "__solid" : ""}.png`)
        if (FULL && !scene) {
          const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
          await page.screenshot({
            path: file,
            fullPage: true,
            ...(h > MAX_H ? { clip: { x: 0, y: 0, width: vp.width, height: MAX_H } } : {}),
          })
        } else await page.screenshot({ path: file })
        const bottom = vp.width < 768 && !scene ? await page.evaluate(bottomBarAudit) : null
        report.push({ route: entry, vp: vpName, theme: themeName, status: nav?.status(), file, logs: [...new Set(logs)], ...audit, bottom })
        await page.close()
      }
      await context.close()
    }
  }
  await browser.close()

  // console summary
  let problems = 0
  for (const r of report) {
    const bad = []
    if (r.overflow) bad.push(`OVERFLOW ${r.overflow.scrollWidth}>${r.overflow.innerWidth} ${JSON.stringify(r.wide)}`)
    if (r.logs.length) bad.push(`console: ${r.logs.join(" | ")}`)
    if (r.unnamed.length) bad.push(`unnamed: ${JSON.stringify(r.unnamed.slice(0, 8))}`)
    if (r.imgNoAlt) bad.push(`img without alt: ${r.imgNoAlt}`)
    if (r.bottom && r.bottom.covered.length) bad.push(`covered by bottom bar: ${JSON.stringify(r.bottom.covered)}`)
    if (r.status && r.status >= 400) bad.push(`status ${r.status}`)
    if (r.smallTargets.length && VIEWPORTS[r.vp].width < 1024) {
      const names = [...new Set(r.smallTargets.map((t) => `${t.name || t.el.split(".")[0]} ${t.w}x${t.h}`))]
      bad.push(`small targets(<36px) x${r.smallTargets.length}: ${names.slice(0, 6).join("; ")}`)
    }
    console.log(`${bad.length ? "!!" : "ok"} ${r.route} ${r.vp}/${r.theme}  title="${r.title}"  ${bad.join("\n     ")}`)
    problems += bad.length
  }
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2))
  console.log(`\n${report.length} shots → ${OUT}; ${problems} page(s) with findings`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
