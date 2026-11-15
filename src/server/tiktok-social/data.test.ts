// TikTok Social normalisation (17-tiktok-social.md §6): shapes from the live probe of 2026-11-15, names / texts
// anonymised. Third-party text is masked (TS3) and cleaned; signed avatar links and hashed user ids never leave.
import { describe, expect, it } from "vitest"

import { getTrends, listComments, listMentions, listVideos, maskedText, tiktokTime, toProfile } from "./data"

type Raw = Record<string, unknown>
/** a fake caller recording the TikTok tool calls */
function fakeCall(answers: Record<string, Raw | ((args: Raw) => Raw)>) {
  const calls: { name: string; args: Raw }[] = []
  const call = async (name: string, args: Raw) => {
    calls.push({ name, args })
    const a = answers[name]
    if (!a) throw new Error(`unexpected ${name}`)
    return typeof a === "function" ? a(args) : a
  }
  return { call, calls }
}

describe("helpers", () => {
  it("tiktokTime: epoch seconds string and 'YYYY-MM-DD HH:MM:SS' (UTC)", () => {
    expect(tiktokTime("1790475100")).toBe("2026-09-27T02:11:40.000Z")
    expect(tiktokTime("2026-09-27 02:16:54")).toBe("2026-09-27T02:16:54.000Z")
    expect(tiktokTime("soon")).toBeNull()
  })

  it("maskedText: masks phone / e-mail, removes bidi controls, counts", () => {
    const c = { phones: 0, emails: 0 }
    expect(maskedText("Gọi em 0912 345 678 ‮hoặc a.b@gmail.com", c)).toBe("Gọi em [SĐT ẩn …678] hoặc [email ẩn]")
    expect(c).toEqual({ phones: 1, emails: 1 })
  })

  it("toProfile: username lower case, https links only", () => {
    expect(toProfile({ username: "@ShopABC", display_name: "Shop ABC", profile_deep_link: "https://vm.tiktok.com/x/", is_business_account: false })).toMatchObject({
      username: "shopabc",
      displayName: "Shop ABC",
      profileUrl: "https://vm.tiktok.com/x/",
      isBusinessAccount: false,
    })
    expect(toProfile({ username: "bad name!", profile_deep_link: "javascript:alert(1)" })).toMatchObject({ username: null, profileUrl: null })
  })
})

describe("videos", () => {
  it("lifetime metrics, share URL without tracking query, cursor only while has_more", async () => {
    const { call, calls } = fakeCall({
      account_user_post_list_get: {
        has_more: true,
        cursor: 1786937901341,
        videos: [
          {
            item_id: "7690027971402337544",
            media_type: "VIDEO",
            create_time: "1790474174",
            caption: "Chạy quảng cáo",
            share_url: "https://www.tiktok.com/@shop/video/7690027971402337544?utm_campaign=tt4d_open_api&utm_source=1",
            video_views: 2952,
            likes: 73,
            full_video_watched_rate: 0.0299,
          },
          { media_type: "VIDEO" },
        ],
      },
    })
    const res = await listVideos(call, { limit: 5, cursor: null })
    expect(calls[0]!.args).toMatchObject({ max_count: 5 })
    expect(calls[0]!.args.fields).toContain("item_id")
    expect(res.nextCursor).toBe(1786937901341)
    expect(res.videos).toHaveLength(1)
    expect(res.videos[0]).toMatchObject({
      video_id: "7690027971402337544",
      created_at: "2026-09-27T01:56:14.000Z",
      url: "https://www.tiktok.com/@shop/video/7690027971402337544",
      views: 2952,
      likes: 73,
      full_watch_rate: 0.0299,
      comments: null,
    })
  })
})

describe("comments", () => {
  const page = {
    has_more: false,
    cursor: 30,
    comments: [
      {
        comment_id: "7690031793488233236",
        video_id: "7690027971402337544",
        create_time: "1790475100",
        text: "Zalo em 0987654321 nhé",
        username: "khach_a",
        display_name: "Khách A",
        user_id: "fd03a766b6fd8c855e9bfbc51d84",
        unique_identifier: "+dYU8I6kQ0w",
        profile_image: "https://p16.tiktokcdn.com/a.jpeg?x-signature=SIG",
        likes: 0,
        owner: false,
        pinned: false,
        liked: false,
        status: "PUBLIC",
        reply_list: [
          { comment_id: "7690033239394927378", parent_comment_id: "7690031793488233236", create_time: "2026-09-27 02:16:54", text: "Shop gọi lại ạ", username: "shop", display_name: "Shop", owner: true, likes: 1 },
        ],
      },
    ],
  }

  it("sort + status mapping; replies nested, owner_replied; masked; no avatar / hashed ids", async () => {
    const { call, calls } = fakeCall({ account_user_comment_list_get: page })
    const res = await listComments(call, { videoId: "7690027971402337544", sort: "newest", includeReplies: true, includeHidden: false, limit: 20, cursor: null })
    expect(calls[0]!.args).toEqual({
      video_id: "7690027971402337544",
      max_count: 20,
      status: "PUBLIC",
      sort_field: "create_time",
      sort_order: "desc",
      include_replies: true,
    })
    expect(res.nextCursor).toBeNull()
    expect(res.masked).toEqual({ phones: 1, emails: 0 })
    const c = res.comments[0]!
    expect(c).toMatchObject({
      comment_id: "7690031793488233236",
      text: "Zalo em [SĐT ẩn …321] nhé",
      author: { username: "khach_a", display_name: "Khách A", is_owner: false },
      reply_count: 1,
      owner_replied: true,
    })
    expect(c.replies![0]).toMatchObject({ created_at: "2026-09-27T02:16:54.000Z", author: { is_owner: true } })
    const out = JSON.stringify(res)
    expect(out).not.toMatch(/x-signature|fd03a766|unique_identifier|0987654321/)
  })

  it("a comment without replies is marked owner_replied: false", async () => {
    const { call } = fakeCall({ account_user_comment_list_get: { comments: [{ comment_id: "1", text: "Có chạy cho fanpage được không", owner: false }], has_more: false } })
    const res = await listComments(call, { videoId: "9", sort: "newest", includeReplies: true, includeHidden: false, limit: 20, cursor: null })
    expect(res.comments[0]).toMatchObject({ replies: [], owner_replied: false })
  })

  it("comment_id → reply list endpoint, hidden included, oldest first", async () => {
    const { call, calls } = fakeCall({ account_user_comment_reply_list_get: { comments: [], has_more: false } })
    await listComments(call, { videoId: "1", sort: "oldest", includeReplies: true, includeHidden: true, limit: 10, cursor: 20, commentId: "2" })
    expect(calls[0]).toEqual({
      name: "account_user_comment_reply_list_get",
      args: { video_id: "1", max_count: 10, status: "ALL", sort_field: "create_time", sort_order: "asc", cursor: 20, comment_id: "2" },
    })
  })
})

describe("mentions + trends", () => {
  it("mention comments ask only the fields TikTok allows (live 2026-11-15) and mask the text", async () => {
    const { call, calls } = fakeCall({
      account_user_mention_comment_list_get: { comments: [{ item_id: "5", comment_id: "6", comment_text: "@shop sđt 0912345678", commenter_display_name: "Khách", comment_type: "COMMENT" }] },
    })
    const res = await listMentions(call, { kind: "comments", username: "shop", days: 30, limit: 10, cursor: null })
    expect(calls[0]!.args.fields).not.toContain("commenter_handle_name")
    expect(calls[0]!.args.fields).toContain("commenter_display_name")
    expect(res.items[0]).toMatchObject({ commenter: "Khách", text: "@shop sđt [SĐT ẩn …678]" })
  })

  it("mentions on a non-Business account: empty data → no item, no cursor", async () => {
    const { call } = fakeCall({ account_user_mention_post_list_get: {} })
    await expect(listMentions(call, { kind: "posts", username: "shop", days: 30, limit: 10, cursor: null })).resolves.toEqual({
      items: [],
      nextCursor: null,
      masked: { phones: 0, emails: 0 },
    })
  })

  it("hashtag suggestions: spaces removed from the keyword (TikTok refuses them)", async () => {
    const { call, calls } = fakeCall({
      account_user_hashtag_suggestion_get: { suggestions: [{ name: "oplung", post_count: 796540, view_count: 3975128901 }] },
    })
    const res = await getTrends(call, { kind: "hashtag_suggestions", query: "op lung", personalized: false, countryCode: "VN", dateRange: "7DAY", language: "vi-VN", limit: 10 })
    expect(calls[0]!.args).toEqual({ keyword: "oplung", language: "vi-VN" })
    expect(res.items).toEqual([{ hashtag: "oplung", posts: 796540, views: 3975128901 }])
  })

  it("trending keywords are ranked strings", async () => {
    const { call } = fakeCall({ discovery_search: { search_keywords: ["A", "B"] } })
    await expect(getTrends(call, { kind: "trending_keywords", personalized: true, countryCode: "VN", dateRange: "7DAY", language: "vi-VN", limit: 20 })).resolves.toEqual({
      items: [
        { keyword: "A", rank: 1 },
        { keyword: "B", rank: 2 },
      ],
    })
  })
})
