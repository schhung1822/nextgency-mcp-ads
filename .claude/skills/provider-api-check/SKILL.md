---
name: provider-api-check
description: Kiểm tra lại tài liệu API của một nền tảng quảng cáo (meta | openai-ads; nền tảng sắp ra mắt: xem 12-platform-rollout.md) với nguồn chính thức — version mới, ngày hết hạn, breaking change, endpoint/field bị đổi — rồi cập nhật file trong .claude/docs/providers/. Dùng trước khi code adapter, khi gặp lỗi lạ từ API, hoặc khi tài liệu đã cũ hơn 30 ngày.
argument-hint: "<meta|openai-ads|all>"
allowed-tools: WebSearch WebFetch Read Grep Glob Edit Bash(npm view *)
---

# Kiểm tra API nền tảng: `$ARGUMENTS`

1. Đọc `.claude/docs/providers/<platform>.md` (ghi lại ngày research ở đầu file và các mục đánh dấu [M]/[L]).
2. Kiểm tra nguồn chính thức:
   - **meta**: https://developers.facebook.com/docs/graph-api/changelog/versions/ (version mới nhất + ngày hết hạn Marketing API), changelog version mới nhất, out-of-cycle changes năm hiện tại (`/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-<năm>`), blog developers.
   - **openai-ads**: changelog trên https://developers.openai.com/ads/api-overview (hoặc `.md`), tải lại `https://developers.openai.com/ads/openapi.json` và so `info.version` + danh sách path với bản trong `.claude/docs/providers/openai-ads.openapi.json`.
   - Thư viện liên quan (nếu cần): `npm view <pkg> version`.
3. Với mỗi khác biệt: ghi vào file nền tảng (mục "Phiên bản" / "Breaking changes" / bảng endpoint), cập nhật **ngày research** ở đầu file, bỏ/giữ nhãn [M]/[L] theo bằng chứng mới. OpenAI: thay file openapi.json nếu version mới.
4. Nếu version API mặc định cần nâng: cập nhật hằng số mặc định trong `.claude/docs/02-architecture.md` §4 và `07-deployment.md` §1 (code thật: `src/server/providers/<platform>/client.ts`) — **hỏi chủ dự án trước khi nâng trong code**.
5. Báo cáo ngắn (tiếng Việt): thay đổi quan trọng, ảnh hưởng tới tool/adapter nào, việc cần làm, mục nào vẫn chưa xác nhận được.
