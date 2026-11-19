# Triển khai Ads MCP trên VPS (hướng dẫn chi tiết)

> Dành cho người vận hành của đơn vị được Nextgency cấp quyền. Làm lần lượt từ trên xuống, mỗi khối lệnh có thể sao chép và chạy nguyên văn (chỉ thay các giá trị ví dụ như `mcp.congty.vn`, `it@congty.vn`, `deploy`).
>
> Phiên bản tài liệu: 1.0.0 (cập nhật 2026-10-03, thêm phương án D - Cloudflare Tunnel). Mã nguồn: repo **riêng tư** `schhung1822/nextgency-mcp-ads`. Image dựng sẵn (riêng tư): `ghcr.io/schhung1822/nextgency-mcp-ads:<phiên bản>` và `ghcr.io/schhung1822/nextgency-mcp-ads-updater:<phiên bản>`, bản đầu tiên `1.0.0` (tag git `v1.0.0`).

## Mục lục
0. [Cài nhanh bằng script (khuyến nghị)](#0-cài-nhanh-bằng-script-khuyến-nghị)
1. [Tổng quan và chọn phương án SSL](#1-tổng-quan-và-chọn-phương-án-ssl)
2. [Yêu cầu](#2-yêu-cầu)
3. [Chuẩn bị máy chủ](#3-chuẩn-bị-máy-chủ)
4. [Cài Docker Engine](#4-cài-docker-engine)
5. [Quyền truy cập GitHub (mã nguồn + image riêng tư)](#5-quyền-truy-cập-github-mã-nguồn--image-riêng-tư)
6. [Lấy mã nguồn, đăng nhập GHCR, tạo `.env`](#6-lấy-mã-nguồn-đăng-nhập-ghcr-tạo-env)
7. [Khởi chạy bằng image dựng sẵn](#7-khởi-chạy-bằng-image-dựng-sẵn)
8. [Phương án A - Caddy tự cấp HTTPS (mặc định)](#8-phương-án-a---caddy-tự-cấp-https-mặc-định)
9. [Phương án B - Cloudflare](#9-phương-án-b---cloudflare)
10. [Phương án C - Nginx + Certbot](#10-phương-án-c---nginx--certbot)
    - [10b. Phương án D - Cloudflare Tunnel](#10b-phương-án-d---cloudflare-tunnel) (đánh số 10b để giữ nguyên số các mục sau, vốn được nhắc tới trong web)
11. [Cập nhật phiên bản](#11-cập-nhật-phiên-bản)
12. [Sao lưu và khôi phục](#12-sao-lưu-và-khôi-phục)
13. [Giám sát và xử lý sự cố](#13-giám-sát-và-xử-lý-sự-cố)
14. [Giới hạn GHCR (gói Free)](#14-giới-hạn-ghcr-gói-free)
15. [Phụ lục](#15-phụ-lục)

---

## 0. Cài nhanh bằng script (khuyến nghị)

Script `install-ads-mcp.sh` (nằm trong repo <https://github.com/schhung1822/nextgency-mcp-ads> ở `scripts/install-ads-mcp.sh`; script không chứa bí mật — vẫn cần tài khoản GitHub được Nextgency cấp quyền + token mới cài được) làm tự động các mục 3.4, 3.5, 4, 6, 7 (và 10b.4 với Cloudflare Tunnel) trên **VPS mới** Ubuntu 22.04/24.04 hoặc Debian 12/13 (amd64/arm64), bằng **một lệnh**. Thời gian khoảng 5-15 phút, phần lớn là tải Docker và image. Các mục còn lại của tài liệu này vẫn dùng để hiểu hệ thống, xử lý sự cố và cài tay.

### 0.1 Cần chuẩn bị
| Thứ cần có | Ghi chú |
|---|---|
| VPS | Đăng nhập được bằng `root` hoặc user có `sudo`. Tối thiểu 2 GB RAM (ít hơn: script tạo swap), ổ đĩa trống ≥ 10 GB (khuyến nghị ≥ 20 GB) |
| Tên miền con, vd `mcp.congty.vn` | **Cách 1 - tự động (mặc định):** bản ghi **A** trỏ IPv4 của VPS; nếu DNS ở Cloudflare thì để **DNS only** (mây xám); không tạo AAAA; mở 22, 80, 443 ở tường lửa của nhà cung cấp VPS. **Cách 2 - Cloudflare Tunnel:** tạo tunnel + route `http://caddy:80` theo 10b.3 và sao chép token `eyJ…` (không cần bản ghi A, không mở cổng) |
| Tài khoản GitHub đã được Nextgency cấp quyền Read | Còn lời mời chưa chấp nhận: script hỏi và chấp nhận giúp |
| **1 token GitHub** | PAT classic tích `repo` + `read:packages` (mục 5.1, có link tích sẵn). Một token dùng cho mọi việc |
| Email | Nhận thông báo của Let's Encrypt (cách 1) |

### 0.2 Chạy
Trên VPS, tải script từ repo rồi chạy (cách `curl` dưới đây chỉ dùng được khi repo **công khai**; repo riêng tư thì chép file như bên dưới). Nên tải về trước để xem nội dung file:
```bash
curl -fsSL https://raw.githubusercontent.com/schhung1822/nextgency-mcp-ads/main/scripts/install-ads-mcp.sh -o install-ads-mcp.sh
sudo bash install-ads-mcp.sh
```
Hoặc chép file lên VPS (trên máy tính của bạn: `scp install-ads-mcp.sh root@IP_VPS:/root/`), rồi trên VPS:
```bash
sudo bash install-ads-mcp.sh
```
Chạy kiểu `curl -fsSL <link> | sudo bash` cũng được (script đọc câu trả lời từ bàn phím nên vẫn hỏi bình thường). Lệnh `ads-mcp` được lấy theo thứ tự: trong bản phát hành đang cài → cạnh file script → nhánh `main` của repo phần mềm (bằng token) → repo công khai ở trên.

Các câu hỏi (Enter = giá trị trong ngoặc vuông; nhập sai thì hỏi lại):

| Câu hỏi | Ghi chú |
|---|---|
| Tên miền chạy phần mềm | vd `mcp.congty.vn` (không `http://`, không `/`) |
| Cách đưa web ra Internet `[1]` | `1` = tự động (Caddy + Let's Encrypt), `2` = Cloudflare Tunnel. Cloudflare proxy mây cam (mục 9) và Nginx (mục 10) cài tay |
| Email | Bắt buộc với cách 1; cách 2 có thể bỏ trống |
| Tên tài khoản GitHub | Tài khoản đã được Nextgency cấp quyền |
| Token GitHub | **Nhập ẩn** (không hiện ra màn hình). Kiểm tra ngay: sai/hết hạn, token của tài khoản khác, thiếu `repo`/`read:packages`, token fine-grained, chưa có quyền đọc repo: báo rõ lý do và cách sửa. Hiện ngày hết hạn, cảnh báo khi còn dưới 30 ngày |
| Token Cloudflare Tunnel | Chỉ cách 2, nhập ẩn |
| Bật tường lửa UFW? `[Y/n]` | Mở cổng SSH đang dùng **trước** khi bật; cách 1 mở thêm 80/tcp, 443/tcp, 443/udp |
| Bật cập nhật tự động? `[Y/n]` | Service `updater` (mục 11.1) |
| Cài với các thông tin trên? `[Y/n]` | Bảng tóm tắt (token chỉ hiện 4 ký tự đầu và cuối) |

Không tương tác (tự động hoá; thông tin bí mật chỉ nhận qua biến môi trường hoặc ô nhập ẩn, tham số `--token` bị từ chối):
```bash
sudo ADS_MCP_GITHUB_TOKEN='ghp_...' bash install-ads-mcp.sh --yes --domain mcp.congty.vn --email it@congty.vn --github-user congty-ads-server
# Cloudflare Tunnel: thêm --ssl tunnel và ADS_MCP_TUNNEL_TOKEN='eyJ...'
# Tuỳ chọn khác: --no-firewall --no-updater --version 1.0.6 --dir /opt/ads-mcp --skip-dns-check --force-os (xem --help)
```
Dòng lệnh có token nằm trong lịch sử shell: chỉ dùng cho tự động hoá, người vận hành nên để script hỏi ẩn.

### 0.3 Script làm gì
1. Kiểm tra máy: quyền root, hệ điều hành, kiến trúc, RAM, ổ đĩa, kết nối tới GitHub.
2. Cài công cụ: `ca-certificates curl git openssl jq iproute2`.
3. Hỏi thông tin, kiểm tra token với GitHub (như bảng trên) và lấy **bản phát hành mới nhất** (bỏ qua bản nháp/bản thử, giống kiểm tra bản mới trong web); `--version x.y.z` để cài đúng một bản (từ 1.0.2).
4. Cách 1: so IPv4 công khai của VPS với bản ghi A (báo riêng trường hợp đám mây cam Cloudflare, sai IP, chưa có bản ghi; cảnh báo khi có AAAA); cổng 80/443 phải trống (đang có Nginx/Apache thì dừng và hướng dẫn).
5. Swap 2 GB khi RAM ≤ 2,5 GB và chưa có swap (mục 3.4).
6. UFW (mục 3.5). Không sửa cấu hình SSH.
7. Docker Engine + Compose từ kho apt chính thức (mục 4); máy đã có Docker thì giữ nguyên.
8. `git clone` đúng tag `vX.Y.Z` vào `/opt/ads-mcp` (token đưa qua `GIT_ASKPASS`, không lưu vào `.git/config`), tạo `backups/` quyền 700.
9. `docker login ghcr.io` bằng root (`/root/.docker/config.json`, không dùng credential helper; updater dùng chung).
10. Tạo `.env` bằng `scripts/gen-secrets.sh` (khoá bí mật ngẫu nhiên, mục 6.3) và điền `UPDATE_REPO`, `UPDATE_GITHUB_TOKEN`, `TUNNEL_TOKEN` (cách 2), `APP_VERSION`, `COMPOSE_PROFILES`, `HOST_PROJECT_DIR`; quyền 600.
11. `docker compose pull` + `up -d --no-build`, đợi migrate xong và web healthy (tối đa 5 phút), rồi kiểm tra HTTPS: cách 1 đợi Caddy lấy chứng chỉ tối đa 3 phút (chưa được thì ghi "chưa xác nhận", hệ thống vẫn chạy, Caddy tự thử lại); cách 2 kiểm tra caddy → web và cloudflared đã kết nối.
12. Kiểm tra updater, worker, backup, số tài khoản; cài lệnh `ads-mcp`; in màn hình cuối.

Nhật ký: `/var/log/ads-mcp-install.log` (quyền 600, **không** chứa token, mật khẩu hay mã cài đặt). Lỗi giữa chừng: script báo bước bị dừng, 20 dòng cuối nhật ký và cách xử lý; khắc phục rồi chạy lại đúng lệnh cũ.

**Script không làm** (tự làm nếu cần): tạo user `deploy`, đăng nhập SSH bằng khoá và tắt mật khẩu (3.2, 3.3), fail2ban (3.6), `unattended-upgrades` (3.1), tường lửa của nhà cung cấp VPS, đẩy bản sao lưu ra ngoài VPS (12.2). Mọi lệnh `docker compose` về sau chạy bằng `sudo` trong `/opt/ads-mcp` (thông tin đăng nhập GHCR nằm ở `/root/.docker`).

### 0.4 Màn hình cuối
Ví dụ (mã cài đặt đã che; mã chỉ in ra màn hình, không ghi vào nhật ký):
```text
════════════════════════════════════════════════════════════════════════
 ✅ CÀI ĐẶT THÀNH CÔNG — Ads MCP by Nextgency v1.0.6
════════════════════════════════════════════════════════════════════════

👉 BƯỚC TIẾP THEO: tạo tài khoản quản trị (admin)
   1. Mở trình duyệt:  https://mcp.congty.vn/setup
   2. Nhập MÃ CÀI ĐẶT (setup key):

        ••••••••••••••••••••••••••••••••

   3. Nhập tên, email, mật khẩu mạnh → tạo tài khoản. Trang /setup tự khoá khi đã có tài khoản.
   Xem lại mã: sudo ads-mcp setup-key   (không gửi mã này qua chat/email)

📋 Thông tin cài đặt
   Thư mục:            /opt/ads-mcp
   File cấu hình:      /opt/ads-mcp/.env  ⚠ chứa khoá bí mật: SAO LƯU NGAY vào nơi an toàn khác máy chủ
   Phiên bản:          1.0.6
   HTTPS:              hoạt động (Let's Encrypt)
   Cập nhật tự động:   Bật - đã thấy bản mới nhất v1.0.6
   Token GitHub:       tài khoản congty-ads-server, hết hạn 09/10/2027 (còn 365 ngày) — đổi token: sudo ads-mcp token
   Swap:               đã tạo /swapfile 2 GB
   Tường lửa:          UFW bật: SSH (22), 80/tcp, 443/tcp, 443/udp
   Thời gian:          7 phút 12 giây
   Nhật ký cài đặt:    /var/log/ads-mcp-install.log

🔒 Nên làm sau khi tạo admin
   • Tài khoản → bật xác thực 2 lớp (2FA), cất 10 mã dự phòng ở nơi an toàn.
   • Cài đặt → Bảo mật → bật "Bắt buộc 2FA cho quản trị viên".
   • Đưa bản sao lưu (/opt/ads-mcp/backups) ra ngoài máy chủ, có mã hoá (docs/deploy-vps.md 12.2).
   • Cài đặt → Cập nhật → Kiểm tra ngay: phải thấy bản mới nhất, không báo lỗi token.

🛠 Lệnh hữu ích
   sudo ads-mcp status        trạng thái các dịch vụ
   ...
```
Đã có tài khoản (chạy lại script): khung "Bước tiếp theo" thay bằng dòng "Hệ thống đã có tài khoản quản trị", không in mã. Sau đó làm tiếp mục 7.2 (bảo mật tài khoản) và sao lưu `.env` (mục 6.3).

### 0.5 Lệnh `ads-mcp`
Cài ở `/usr/local/bin/ads-mcp` (thư mục cài đặt ghi trong `/etc/ads-mcp.conf`). Chạy bằng `sudo`:

| Lệnh | Làm gì |
|---|---|
| `sudo ads-mcp status` | Phiên bản, trạng thái từng dịch vụ, HTTPS / tunnel |
| `sudo ads-mcp logs [dịch vụ]` | Xem nhật ký trực tiếp (`web`, `worker`, `caddy`, `updater`, `db`, `backup`, `cloudflared`…), Ctrl+C để thoát |
| `sudo ads-mcp doctor` | Tự kiểm tra: Docker, `.env`, từng dịch vụ, HTTPS, đăng nhập GHCR, token GitHub (hạn, quyền), bản mới, cấu hình triển khai đúng phiên bản, ổ đĩa, bản sao lưu gần nhất; mỗi lỗi kèm cách sửa |
| `sudo ads-mcp setup-key` | In lại mã cài đặt + link `/setup` (chỉ khi chưa có tài khoản nào) |
| `sudo ads-mcp token` | Đổi token GitHub: kiểm tra token mới, đăng nhập lại GHCR, ghi `UPDATE_GITHUB_TOKEN` (bản cũ ở `.env.bak`), khởi động lại web/worker |
| `sudo ads-mcp update` | So bản đang chạy với bản mới nhất, hướng dẫn cập nhật (trong web, hoặc tay khi tắt updater); tuỳ chọn tải lại image của bản hiện tại |
| `sudo ads-mcp update-config` | Lấy file cấu hình triển khai (`docker-compose.yml`, `Caddyfile`, `deploy/`, script) đúng tag `APP_VERSION`, `docker compose up -d --no-build`, nạp lại Caddy nếu cần, cập nhật chính lệnh `ads-mcp` |
| `sudo ads-mcp backup` | Sao lưu database ngay (lệnh của mục 12.1) |
| `sudo ads-mcp version` / `help` | Phiên bản / danh sách lệnh |

### 0.6 Chạy lại script
- Máy đã có `/opt/ads-mcp/.env` → **chế độ sửa chữa** (hỏi xác nhận trước): **không** tạo lại khoá bí mật, không đụng dữ liệu, không đổi phiên bản (trừ khi thêm `--version x.y.z`); kiểm tra token (Enter = giữ token đang có trong `.env`, hoặc dán token mới), đăng nhập lại GHCR, bổ sung biến cập nhật còn thiếu trong `.env`, cài lại `ads-mcp`, `docker compose up -d --no-build`, kiểm tra và in lại màn hình cuối. Dùng khi đổi token, khi dịch vụ không tự lên, hoặc thiếu cấu hình.
- Lần cài trước dừng giữa chừng (chưa có `.env`): chạy lại như cài mới, script dùng lại mã nguồn đã tải.
- Thư mục cài bằng script ở **tag cố định** của bản phát hành (không theo nhánh `main`), nên không dùng `git pull`: khi ghi chú phát hành yêu cầu lấy cấu hình mới (mục 11.1), chạy `sudo ads-mcp update-config` sau khi cập nhật trong web.

---

## 1. Tổng quan và chọn phương án SSL

```
           Internet (HTTPS)                    VPS (Docker Compose, thư mục /opt/ads-mcp)
 Trình duyệt ─┐                    ┌──────────────────────────────────────────────────────┐
 Claude/GPT ──┼──► [Cloudflare]? ──┼─► caddy :80/:443  ──►  web :3000 (UI + /mcp/<key>)   │
 Gemini     ──┘   (phương án B, D) │   (hoặc Nginx trên      worker (job nền)              │
                       ║           │    máy chủ - phương án C) migrate (chạy 1 lần)        │
                       ║ tunnel    │                         db PostgreSQL 18 (không mở cổng)│
                       ╚═══════════╪═ cloudflared ─► caddy:80 (phương án D, không mở cổng) │
                                   │                         backup -> ./backups            │
                                   │                         updater (cập nhật tự động)     │
                                   └──────────────────────────────────────────────────────┘
        image kéo từ ghcr.io (riêng tư)  ◄── docker login (PAT classic repo + read:packages, mục 5)
```

**Nguyên tắc:** VPS **chỉ kéo image dựng sẵn** từ GHCR, không build. Build Next.js trên VPS nhỏ rất lâu và dễ hết RAM. Từ 1.0.0, `docker-compose.yml` cố ý **không có `build:`**: kéo image lỗi (chưa đăng nhập, PAT hết hạn, sai phiên bản) thì lệnh báo lỗi ngay, không âm thầm build từ mã nguồn rồi gắn nhãn sai phiên bản. Build từ mã nguồn chỉ dùng trên máy dev, qua `docker-compose.build.yml`.

| Phương án | Khi nào chọn | Ưu điểm | Nhược điểm |
|---|---|---|---|
| **A. Caddy tự động** (mặc định) | Hầu hết trường hợp: VPS có IP công khai, mở được cổng 80/443 | Không phải cấu hình gì, chứng chỉ tự gia hạn, đã kiểm thử nhiều nhất | Không có chống DDoS/WAF của CDN |
| **B. Cloudflare** (mây cam) | Đã quản lý DNS ở Cloudflare, cần ẩn IP VPS, WAF, chống DDoS | Ẩn IP gốc, WAF, chặn được truy cập thẳng vào VPS (AOP) | Cloudflare cắt request quá **125 giây**; phải cấu hình đúng IP thật, cache, bot; gói Free không tắt được Bot Fight Mode riêng cho `/mcp/` |
| **C. Nginx + Certbot** | Máy chủ đã chạy Nginx cho site khác, hoặc tổ chức bắt buộc dùng Nginx | Dùng chung Nginx có sẵn | Nhiều bước tay hơn, tự lo gia hạn (Certbot), dễ cấu hình sai IP khách |
| **D. Cloudflare Tunnel** | VPS **không có IP công khai** hoặc không mở được cổng 80/443 (sau NAT, máy chủ trong văn phòng), hoặc muốn VPS **không mở cổng vào nào** ngoài SSH; DNS đã ở Cloudflare | Không mở cổng 80/443, IP VPS không lộ, không cần chứng chỉ trên VPS (Cloudflare lo HTTPS), không ai gọi thẳng được vào VPS (không cần AOP/iptables), IP thật của khách IPv6 vẫn đúng | Phụ thuộc hoàn toàn vào Cloudflare (tunnel/Cloudflare lỗi là web và MCP ngừng); giới hạn **125 giây** như B và **không** chuyển sang DNS only được; thêm 1 container và 1 secret (`TUNNEL_TOKEN`); vẫn phải cấu hình bot/WAF/cache như B |

Cả 4 phương án dùng **cùng một** `docker-compose.yml` và `Caddyfile`, chọn bằng vài biến trong `.env` (mục 6.3; `gen-secrets.sh --ssl auto|cloudflare|nginx|tunnel` điền sẵn). Service `updater` hoạt động như nhau ở cả 4 phương án (chỉ thay `web` + `worker`, không đụng `caddy`/`cloudflared`).

> [!IMPORTANT]
> **IP thật của khách rất quan trọng.** App chỉ tin **hop đầu tiên** của header `X-Forwarded-For` do reverse proxy ghi. Khoá đăng nhập theo IP, giới hạn tốc độ MCP, allowlist IP của MCP và nhật ký đều dựa vào IP này. Cấu hình sai thì: hoặc **mọi người dùng chung một IP** (IP của Cloudflare/Docker) nên một kẻ đoán mật khẩu làm khoá luôn người thật và allowlist IP vô dụng; hoặc kẻ tấn công **tự khai IP bất kỳ** để né khoá. Các file cấu hình trong `deploy/` đã xử lý đúng: chỉ cần làm theo, đừng tự sửa phần header.

---

## 2. Yêu cầu

| Hạng mục | Tối thiểu | Khuyến nghị |
|---|---|---|
| CPU | 2 vCPU | 2-4 vCPU |
| RAM | 2 GB (+ 2 GB swap) | 4 GB |
| Ổ đĩa | 20 GB SSD | 40 GB+ (log MCP ~1-2 KB/lượt gọi, bản sao lưu, image các phiên bản) |
| Hệ điều hành | Ubuntu 24.04 LTS, Debian 12 hoặc Debian 13 (64-bit) | Ubuntu 24.04 LTS |
| Kiến trúc | `x86_64` (amd64) hoặc `aarch64` (arm64): image phát hành có cả hai | amd64 |
| Mạng | IPv4 công khai, mở TCP 80, 443 (UDP 443 cho HTTP/3 - tuỳ chọn). Phương án D: **không** cần IP công khai hay cổng vào; chỉ cần đi ra được cổng **7844 TCP + UDP** và 443 tới Cloudflare | |

Tham khảo bộ nhớ: web ~250 MB, worker ~120 MB, PostgreSQL ~300 MB (shared_buffers 256 MB), Caddy ~30 MB. VPS 1 GB RAM không khuyến nghị.

**Tên miền và DNS**
- Dùng một sub-domain riêng, ví dụ `mcp.congty.vn`. Tạo **bản ghi A** trỏ về IPv4 của VPS **trước khi** khởi chạy (Caddy/Certbot cần DNS đúng để xin chứng chỉ). Kiểm tra: `dig +short A mcp.congty.vn` (hoặc `getent hosts mcp.congty.vn`) phải ra IP VPS.
- Claude chỉ kết nối MCP qua IPv4, nên **bắt buộc** có bản ghi A.
- **Không nên tạo bản ghi AAAA (IPv6)** ở phương án A: mạng Docker mặc định chỉ có IPv4, kết nối IPv6 đi qua `docker-proxy` nên app thấy mọi khách IPv6 là **cùng một IP** (gateway Docker, vd `172.18.0.1`) và khoá đăng nhập/giới hạn theo IP gộp chung tất cả khách IPv6. Phương án B (Cloudflare), C (Nginx chạy trên máy chủ) và D (Cloudflare Tunnel) không bị vấn đề này.
- Nhà cung cấp VPS thường có **tường lửa riêng** (Security Group, Cloud Firewall): mở 22, 80, 443 ở đó nữa.
- **Phương án D (Cloudflare Tunnel):** tên miền phải dùng DNS của Cloudflare (zone đang hoạt động trong tài khoản Cloudflare, gói Free được). **Không** tạo bản ghi A: Cloudflare tự tạo bản ghi CNAME tới tunnel khi thêm route (mục 10b.3); nếu đã có bản ghi A/AAAA/CNAME cùng tên thì xoá trước. Tường lửa (UFW và của nhà cung cấp) chỉ cần mở SSH.

---

## 3. Chuẩn bị máy chủ

Đăng nhập lần đầu bằng tài khoản nhà cung cấp cấp (thường là `root`).

### 3.1 Cập nhật hệ thống, múi giờ, gói cơ bản
```bash
apt update && apt -y full-upgrade
apt -y install ca-certificates curl git ufw unattended-upgrades
timedatectl set-timezone Asia/Ho_Chi_Minh      # tuỳ chọn: chỉ ảnh hưởng giờ hiển thị của hệ điều hành
dpkg-reconfigure -plow unattended-upgrades     # chọn Yes: tự cài bản vá bảo mật của hệ điều hành
reboot                                         # nếu có kernel mới
```
App tự dùng `APP_TIMEZONE` (mặc định `Asia/Ho_Chi_Minh`) cho hiển thị và lịch job; database lưu UTC.

### 3.2 Tạo user quản trị (không dùng root hằng ngày)
```bash
adduser deploy                  # đặt mật khẩu mạnh (dùng cho sudo)
usermod -aG sudo deploy
```
Trên **máy tính của bạn**, tạo SSH key (nếu chưa có) và chép lên VPS:
```bash
ssh-keygen -t ed25519 -C "ban@congty.vn"
ssh-copy-id deploy@<IP_VPS>
ssh deploy@<IP_VPS>             # phải vào được mà không hỏi mật khẩu VPS
```

### 3.3 Khoá SSH bằng mật khẩu và đăng nhập root
Chỉ làm **sau khi** đã đăng nhập được bằng key ở bước trên (mở sẵn một phiên SSH thứ hai để phòng khoá nhầm). File đặt tên `00-...` để được đọc **trước** `50-cloud-init.conf` (sshd dùng giá trị xuất hiện đầu tiên):
```bash
sudo tee /etc/ssh/sshd_config.d/00-ads-mcp-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin)'   # phải là: no / no
```

### 3.4 Swap (VPS 2 GB RAM trở xuống)
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

### 3.5 Tường lửa UFW
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH          # = 22/tcp. Đổi cổng SSH thì mở cổng đó TRƯỚC khi bật ufw
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp         # HTTP/3 (tuỳ chọn)
sudo ufw enable
sudo ufw status verbose
```
**Phương án D (Cloudflare Tunnel):** bỏ 3 dòng `allow 80/tcp`, `443/tcp`, `443/udp`, chỉ giữ `OpenSSH`. cloudflared chỉ mở kết nối **ra** ngoài (UFW mặc định `allow outgoing`); nếu tường lửa của nhà cung cấp chặn chiều ra, mở ra cổng **7844 TCP và UDP** (`region1.v2.argotunnel.com`, `region2.v2.argotunnel.com`) và 443 (`api.cloudflare.com`). Đã mở 80/443 từ trước thì có thể đóng sau khi tunnel chạy: `sudo ufw delete allow 80/tcp; sudo ufw delete allow 443/tcp; sudo ufw delete allow 443/udp`.
> [!WARNING]
> **Docker bỏ qua UFW với cổng đã publish.** Theo tài liệu Docker, cổng container publish ra (vd `80:80`) được định tuyến trong bảng `nat` **trước** khi tới các chain mà UFW dùng, nên luật UFW **không** chặn được chúng. Vì vậy cấu hình của dự án:
> - **PostgreSQL không publish cổng nào** (chỉ trong mạng Docker nội bộ).
> - Web chỉ publish ra `127.0.0.1` (không ra Internet kể cả khi UFW tắt).
> - Chỉ Caddy publish 80/443 (phương án A, B). Ở phương án C, Nginx là tiến trình của máy chủ nên UFW áp dụng bình thường. Ở phương án D, Caddy chỉ publish trên `127.0.0.1` (cổng ngẫu nhiên) và cloudflared không publish cổng nào, nên không có cổng Docker nào mở ra Internet.
>
> Không tự thêm `ports:` cho `db` hay đổi web thành `0.0.0.0`. Muốn giới hạn nguồn truy cập vào cổng do Docker publish phải dùng chain `DOCKER-USER` (mục 9.6).

### 3.6 fail2ban (tuỳ chọn, chống dò mật khẩu SSH)
```bash
sudo apt -y install fail2ban python3-systemd
sudo tee /etc/fail2ban/jail.d/sshd.local >/dev/null <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
bantime = 1h
EOF
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```
(`backend = systemd` cần cho Debian 12/13 vì mặc định không có `/var/log/auth.log`.) Đăng nhập web của Ads MCP đã có khoá riêng theo IP/email, không cần fail2ban.

---

## 4. Cài Docker Engine

Cài từ **kho apt chính thức của Docker** (không dùng gói `docker.io` của distro). Lệnh dưới đây chép từ docs.docker.com (truy cập 2026-10-03; Docker Engine hiện là bản 29.x).

### 4.1 Ubuntu 24.04
```bash
# gỡ gói xung đột (nếu có)
sudo apt remove $(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc | cut -f1)

# khoá GPG + kho apt của Docker
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update

# cài Docker Engine + plugin compose
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 4.2 Debian 12 / 13
```bash
sudo apt remove $(dpkg --get-selections docker.io docker-compose docker-doc docker-buildx podman-docker containerd runc | cut -f1)
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 4.3 Bật dịch vụ, cho user `deploy` dùng Docker
```bash
sudo systemctl enable --now docker.service containerd.service
sudo docker run --rm hello-world          # kiểm tra
sudo usermod -aG docker deploy
exit                                      # đăng xuất rồi SSH lại để nhóm có hiệu lực
docker version && docker compose version  # chạy được không cần sudo
```
> [!CAUTION]
> Nhóm `docker` **tương đương quyền root** trên máy chủ (Docker: "The docker group grants root-level privileges to the user"). Chỉ thêm user quản trị tin cậy. Muốn tránh, bỏ qua `usermod` và chạy mọi lệnh `docker ...` bằng `sudo`; khi đó đăng nhập GHCR cũng phải bằng `sudo` (mục 6.2) để thông tin nằm ở `/root/.docker`.

Từ đây, **mọi lệnh `docker`/`docker compose` chạy bằng user `deploy` trong thư mục `/opt/ads-mcp`**. Dùng nhất quán một user: đăng nhập GHCR bằng user nào thì chạy compose bằng user đó.

---

## 5. Quyền truy cập GitHub (mã nguồn + image riêng tư)

Nextgency thêm **tài khoản GitHub do đơn vị chọn** vào repo `schhung1822/nextgency-mcp-ads` với vai trò *outside collaborator*, quyền **Read**. Từ tài khoản đó tạo **một PAT classic** tích **`repo` + `read:packages`** và dùng cho cả 3 việc (từ 2026-10-09; script cài nhanh ở mục 0 dùng đúng token này):

| Dùng cho | Scope cần | Đặt ở đâu |
|---|---|---|
| Kéo image riêng tư từ GHCR (lệnh tay và service `updater`) | `read:packages` | `docker login ghcr.io` (`~/.docker/config.json`) |
| `git clone` / `git pull` qua HTTPS (docker-compose.yml, Caddyfile, script) | `repo` | Dán khi git hỏi mật khẩu (**không** lưu bằng `credential.helper store`); cài bằng script: `sudo ads-mcp update-config` tự dùng token trong `.env` |
| Web/worker kiểm tra bản mới (GitHub Releases) | `repo` | `UPDATE_GITHUB_TOKEN` trong `.env` |

Không dùng PAT fine-grained: GitHub không cho PAT fine-grained truy cập repo mà tài khoản chỉ là *outside collaborator*, và GHCR chỉ nhận PAT classic. Tài khoản chỉ có quyền Read trên repo của Nextgency, nên token bị lộ cũng **không** đẩy được mã hay tag lên repo phần mềm.

> [!WARNING]
> Scope `repo` cho quyền **đọc và ghi mọi repo mà chính tài khoản đó có quyền** (repo cá nhân, repo của tổ chức khác). Token nằm trên máy chủ ở 2 chỗ (`.env` và `config.json` của Docker, chỉ chủ sở hữu đọc được). Nếu tài khoản có repo quan trọng, nên tạo **tài khoản GitHub riêng cho máy chủ** (vd `congty-ads-server`, bật 2FA) và nhờ Nextgency thêm tài khoản này thay cho tài khoản cá nhân (không bắt buộc). Nhân viên giữ tài khoản nghỉ việc: chuyển sang tài khoản khác và xoá token cũ.

### 5.1 Tạo token (PAT classic `repo` + `read:packages`)
GHCR (GitHub Packages) **chỉ nhận PAT classic**, không nhận PAT fine-grained (docs.github.com, 2026-10-03).
1. Đăng nhập tài khoản đã được cấp quyền → **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**. Hoặc mở thẳng <https://github.com/settings/tokens/new?scopes=repo,read:packages&description=ads-mcp-vps> (đã tích sẵn 2 ô).
2. Note: `ads-mcp VPS mcp.congty.vn`.
3. Expiration: chọn ngày cụ thể (vd 1 năm) và **đặt lịch nhắc gia hạn trước 2 tuần**. GitHub khuyến nghị luôn đặt hạn. Token hết hạn = updater và `docker compose pull` báo `denied`/`unauthorized`, web báo không tìm thấy bản phát hành (bản đang chạy không bị ảnh hưởng).
4. Tích **`repo`** (các ô con tự được tích theo) và **`read:packages`**. Không tích `write:packages`, `delete:packages`, `admin:*` hay ô nào khác.
5. Generate, sao chép token ngay (chỉ hiện 1 lần).

Lưu ý: package riêng tư của tổ chức **kế thừa quyền của repo liên kết**, nên tài khoản phải có quyền Read trên repo. Nếu tổ chức bật SAML SSO phải bấm **Configure SSO → Authorize** cho token; nếu tổ chức chặn PAT classic thì liên hệ Nextgency.

**Đổi token** (sắp hết hạn, nghi bị lộ): cài bằng script → `sudo ads-mcp token` (kiểm tra token, đăng nhập lại GHCR, ghi `UPDATE_GITHUB_TOKEN`, khởi động lại web/worker). Cài tay → đăng nhập lại GHCR (6.2), thay dòng `UPDATE_GITHUB_TOKEN=` trong `.env`, `docker compose up -d --no-build`. Sau đó xoá token cũ ở <https://github.com/settings/tokens>.

### 5.2 Dùng token với git và kiểm tra bản mới
Repo riêng tư thì API Releases trả 404 khi không có token, web sẽ báo "Không tìm thấy bản phát hành nào".
- `UPDATE_GITHUB_TOKEN` trong `.env` (mục 6.3). Chỉ `web` và `worker` nhận biến này (updater kéo image bằng thông tin `docker login`).
- Mật khẩu khi `git clone` / `git pull` qua HTTPS hỏi (`Username` = tên tài khoản GitHub, `Password` = token). **Không** ghép token vào URL (bị lưu trong `.git/config`), **không** chạy `git config credential.helper store` (lưu token dạng chữ thường ở `~/.git-credentials`). Tuỳ chọn: `git config --global credential.helper 'cache --timeout=900'` (chỉ giữ trong RAM 15 phút). Script cài nhanh và lệnh `ads-mcp` đưa token cho git qua `GIT_ASKPASS` tạm thời, không lưu lại.

### 5.3 (Nâng cao, tuỳ chọn) Deploy key cho `git pull`
Muốn `git pull` không phải dán token: tạo deploy key chỉ đọc và gửi phần `.pub` cho Nextgency thêm ở **repo → Settings → Deploy keys** ("Allow write access" **không** tick). Token vẫn cần cho `UPDATE_GITHUB_TOKEN` và `docker login`.
```bash
ssh-keygen -t ed25519 -f ~/.ssh/ads-mcp-deploy -N "" -C "ads-mcp@$(hostname)"
cat ~/.ssh/ads-mcp-deploy.pub
cat >> ~/.ssh/config <<'EOF'
Host github-ads-mcp
  HostName github.com
  User git
  IdentityFile ~/.ssh/ads-mcp-deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T github-ads-mcp                                               # sau khi Nextgency báo đã thêm khoá
git -C /opt/ads-mcp remote set-url origin github-ads-mcp:schhung1822/nextgency-mcp-ads.git
```
Lần đầu SSH hỏi xác nhận khoá máy chủ GitHub: so dấu vân tay ED25519 với trang chính thức "GitHub's SSH key fingerprints" (`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`) rồi gõ `yes`. Kết quả đúng: `Hi schhung1822/nextgency-mcp-ads! You've successfully authenticated, but GitHub does not provide shell access.`

### 5.4 Đã cài theo hướng dẫn cũ
- **2 token** (Token A chỉ `read:packages` cho `docker login`, Token B chỉ `repo` cho git + `UPDATE_GITHUB_TOKEN`, theo tài liệu 2026-10-05 đến 2026-10-08): vẫn chạy bình thường, **không bắt buộc đổi**. Muốn gộp về 1 token: tạo token theo 5.1, `docker logout ghcr.io` rồi đăng nhập lại bằng token mới (6.2), thay dòng `UPDATE_GITHUB_TOKEN=` trong `.env`, `docker compose up -d --no-build`, xoá 2 token cũ.
- **Token lưu bằng `git config --global credential.helper store`** (hướng dẫn trước 2026-10-05; token nằm dạng chữ thường ở `~/.git-credentials`). Làm lần lượt (user `deploy`, thư mục `/opt/ads-mcp`):
  1. Tạo token mới (5.1).
  2. `rm -f ~/.git-credentials && git config --global --unset credential.helper` (từ giờ `git pull` hỏi Username + token).
  3. `docker logout ghcr.io`, rồi đăng nhập lại bằng token mới (mục 6.2).
  4. `nano .env`, thay giá trị dòng `UPDATE_GITHUB_TOKEN=` bằng token mới, rồi `docker compose up -d --no-build`.
  5. Xoá token cũ ở <https://github.com/settings/tokens>.
  6. **Cài đặt → Cập nhật → Kiểm tra ngay**: phải thấy phiên bản mới nhất, không báo lỗi token.

---

## 6. Lấy mã nguồn, đăng nhập GHCR, tạo `.env`

### 6.1 Lấy mã nguồn
```bash
sudo mkdir -p /opt/ads-mcp && sudo chown deploy:deploy /opt/ads-mcp
git clone https://github.com/schhung1822/nextgency-mcp-ads.git /opt/ads-mcp   # Username = tên GitHub, Password = token GitHub (mục 5)
cd /opt/ads-mcp
git log --oneline -1          # xem đang ở commit nào
mkdir -p backups && chmod 700 backups   # tạo trước để thư mục thuộc deploy (Docker tự tạo sẽ thuộc root)
```
Đường dẫn thư mục dự án chỉ gồm `A-Za-z0-9._/-` (không khoảng trắng): service `updater` cần mount đúng đường dẫn này.

### 6.2 Đăng nhập GHCR
```bash
read -rs CR_PAT                                   # dán token GitHub (5.1) rồi Enter (không hiện ra màn hình)
printf '%s' "$CR_PAT" | docker login ghcr.io -u <tên-tài-khoản-github> --password-stdin
unset CR_PAT
```
Cùng token này dùng cho `git` và `UPDATE_GITHUB_TOKEN` (mục 5, 6.3). Script cài nhanh (mục 0) đăng nhập bằng root, thông tin nằm ở `/root/.docker/config.json` (đúng mặc định của updater). Thông báo `Login Succeeded` kèm cảnh báo *"credentials are stored unencrypted in /home/deploy/.docker/config.json"* là bình thường trên máy chủ Linux (không có Docker Desktop). Kiểm tra file chứa đúng thông tin đăng nhập:
```bash
ls -l ~/.docker/config.json                       # quyền -rw------- (600)
grep -c '"ghcr.io"' ~/.docker/config.json         # >= 1
grep -E '"credsStore"|"credHelpers"' ~/.docker/config.json || echo "OK: không dùng credential helper"
```
> [!IMPORTANT]
> **Service `updater` đọc thông tin đăng nhập này từ bên trong container** (mount chỉ đọc thư mục `UPDATER_DOCKER_CONFIG` vào `/root/.docker`, mặc định `/root/.docker`). Vì vậy:
> - Đăng nhập bằng user `deploy` → **bắt buộc** đặt `UPDATER_DOCKER_CONFIG=/home/deploy/.docker` trong `.env` (mục 6.3).
> - Đăng nhập bằng `sudo docker login` → thông tin nằm ở `/root/.docker/config.json` (sudo trên Ubuntu đặt `HOME=/root`), giữ mặc định.
> - **Không dùng credential helper** (`credsStore`/`credHelpers` như `pass`, `secretservice`, `desktop`): container updater không có các chương trình đó nên sẽ kéo image thất bại. Nếu `config.json` có `credsStore`, xoá dòng đó, `docker logout ghcr.io` rồi đăng nhập lại.

### 6.3 Tạo `.env`
VPS thường chưa có Node: dùng `scripts/gen-secrets.sh` (tự chạy `gen-env.mjs` trong container `node:24-slim`, cuối cùng mới dùng `openssl`). Chọn phương án bằng `--ssl auto|cloudflare|nginx|tunnel` (mục 1; `tunnel` = phương án D, xem thêm 10b.4 để dán `TUNNEL_TOKEN`):
```bash
cd /opt/ads-mcp
sh scripts/gen-secrets.sh --domain mcp.congty.vn --email it@congty.vn --ssl auto
# có Node >= 20 thì tương đương: node scripts/gen-env.mjs --domain mcp.congty.vn --email it@congty.vn --ssl auto
echo "UPDATER_DOCKER_CONFIG=$HOME/.docker" >> .env   # vì đã docker login bằng user deploy (mục 6.2)
chmod 600 .env
```
Script sinh ngẫu nhiên `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEYS`, `MCP_KEY_PEPPER`, `SETUP_TOKEN` và điền các biến dưới đây. Kiểm tra lại (không in secret):
```bash
grep -E '^(APP_DOMAIN|BETTER_AUTH_URL|ACME_EMAIL|APP_VERSION|COMPOSE_PROFILES|HOST_PROJECT_DIR|UPDATER_DOCKER_CONFIG|CADDY_[A-Z_]+|WEB_HOST_PORT|CLOUDFLARED_[A-Z_]+)=' .env
grep -c '^TUNNEL_TOKEN=eyJ' .env      # chỉ phương án D: 1 = đã dán token (lệnh này không in token)
```

| Biến | Ý nghĩa | Giá trị mẫu |
|---|---|---|
| `APP_DOMAIN` | Tên miền của web (app chỉ nhận MCP với Host đúng tên này) | `mcp.congty.vn` |
| `BETTER_AUTH_URL` | URL công khai, bắt buộc `https://` | `https://mcp.congty.vn` |
| `ACME_EMAIL` | Email đăng ký với Let's Encrypt (phương án A). Phương án khác vẫn phải có giá trị (không dùng tới) | `it@congty.vn` |
| `APP_VERSION` | Phiên bản image sẽ chạy, **không có `v`**, phải là bản đã có trên trang Releases. **Bắt buộc** (trống thì mọi lệnh `docker compose` báo lỗi). Script lấy từ `package.json` (hoặc `--app-version x.y.z`); updater tự ghi khi cập nhật | `1.0.2` |
| `COMPOSE_PROFILES` | `updater` = bật cập nhật tự động | `updater` |
| `HOST_PROJECT_DIR` | Đường dẫn tuyệt đối thư mục dự án (updater cần) | `/opt/ads-mcp` |
| `UPDATER_DOCKER_CONFIG` | Thư mục chứa `docker login` cho updater | `/home/deploy/.docker` |
| `UPDATE_GITHUB_TOKEN` | Token GitHub mục 5, **dùng chung** với `docker login` (repo riêng tư: bắt buộc để web thấy bản mới). Bản cài cũ: Token B chỉ `repo` | `ghp_...` |
| `CADDY_REPLICAS` | `1` chạy Caddy, `0` tắt (phương án C) | `1` |
| `CADDY_CLIENT_IP` | `direct`, `cloudflare` hoặc `tunnel` (cách lấy IP thật) | `direct` |
| `CADDY_TLS` | `auto`, `cloudflare-origin`, `cloudflare-origin-aop`, `tunnel` | `auto` |
| `CADDY_SITE_SCHEME` | Trống = Caddy phục vụ HTTPS (A, B); `http://` = chỉ HTTP trong mạng Docker (D) | trống |
| `CADDY_HTTP_PORT_BIND` / `CADDY_HTTPS_PORT_BIND` | Cổng Caddy mở trên máy chủ, dạng `[IP:]cổng`. A, B: `80` / `443`; D: `127.0.0.1:` (chỉ loopback, cổng ngẫu nhiên) | `80` / `443` |
| `WEB_HOST_PORT` | Cổng web trên `127.0.0.1` (phương án C: `3000`; trống = ngẫu nhiên) | trống |
| `CLOUDFLARED_REPLICAS` | `1` chạy cloudflared (phương án D), `0` tắt | `0` |
| `TUNNEL_TOKEN` | Token của Cloudflare Tunnel (phương án D, **secret**, dán từ dashboard - script không sinh) | trống |
| `CLOUDFLARED_PROTOCOL` | Tuỳ chọn, phương án D: `auto` (mặc định) hoặc `http2` khi mạng chặn UDP | (không đặt) |
| `UPDATER_VERIFY_SIGNATURE` | Tuỳ chọn. `0` = updater **bỏ qua** kiểm tra chữ ký số của image (không khuyến nghị; chỉ dùng tạm khi máy chủ bị chặn mạng tới Sigstore) | (không đặt) |
| `WEB_MEM_LIMIT`, `WORKER_MEM_LIMIT`, `MIGRATE_MEM_LIMIT`, `UPDATER_MEM_LIMIT`, `CADDY_MEM_LIMIT`, `CLOUDFLARED_MEM_LIMIT`, `WEB_PIDS_LIMIT`, `WORKER_PIDS_LIMIT` | Tuỳ chọn. Trần RAM / số tiến trình của từng container (mặc định `1g`, `768m`, `768m`, `512m`, `256m`, `256m`, `512`, `256`). Là mức trần, không phải mức giữ trước; đặt quá thấp container bị tắt vì hết bộ nhớ | (không đặt) |

Thêm token kiểm tra bản mới (sửa bằng `nano .env`, bỏ dấu `#` ở dòng `UPDATE_GITHUB_TOKEN=` và dán **cùng token** đã dùng cho `docker login` ở 6.2; script cài nhanh tự điền):
```ini
UPDATE_GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
```

> [!NOTE]
> `docker-compose.yml` **chỉ truyền vào app các biến có trong danh sách** của nó (`x-env-runtime` cho web + worker, thêm `x-env-web` cho web; migrate chỉ nhận `DATABASE_URL`). Biến tự thêm vào `.env` mà không có trong danh sách sẽ không tới được app; worker không nhận `BETTER_AUTH_SECRET`, `MCP_KEY_PEPPER`, `SETUP_TOKEN`. Với các biến trong danh sách, giá trị `export` sẵn trong shell chạy `docker compose` được ưu tiên hơn `.env`: đừng `export` các biến của app trong `~/.bashrc` trên VPS.

> [!WARNING]
> **Sao lưu `.env` ngay** vào trình quản lý mật khẩu/két an toàn của công ty, **khác nơi** chứa file backup database. Mất `ENCRYPTION_KEYS` = mất toàn bộ token quảng cáo đã lưu (phải dán lại tất cả). Mất `MCP_KEY_PEPPER` = mọi link MCP ngừng hoạt động. Mất `BETTER_AUTH_SECRET` = mọi phiên đăng nhập và 2FA phải thiết lập lại. Không bao giờ chạy lại `gen-secrets.sh --force` trên máy đã có dữ liệu.

---

## 7. Khởi chạy bằng image dựng sẵn

Làm xong mục 6 (và các bước riêng của phương án B/C/D nếu chọn - B/C có thể làm sau, mặc định là A; **D phải tạo tunnel và dán `TUNNEL_TOKEN` trước**, mục 10b.3-10b.4):
```bash
cd /opt/ads-mcp
docker compose pull                 # kéo db, caddy, backup, ads-mcp-simple:<APP_VERSION>, ...-updater:<APP_VERSION>
docker compose up -d --no-build
```
- `docker compose pull` phải kết thúc **không lỗi**. Gặp `denied`, `unauthorized` hoặc `manifest unknown`: xem mục 13.2 trước khi đi tiếp. File compose không có `build:` nên Compose không bao giờ tự build; `--no-build` chỉ là chốt an toàn thêm.
- Thứ tự tự động: `db` (healthy) → `migrate` (chạy migration rồi thoát 0) → `web` + `worker` (+ `updater`) → `caddy` (đợi web healthy) → `cloudflared` (phương án D) → `backup` (sao lưu ngay 1 bản).

Kiểm tra:
```bash
docker compose ps
#   db       running (healthy)
#   migrate  exited (0)          <- đúng, chạy 1 lần rồi thoát
#   web      running (healthy)   <- có thể mất ~30 giây
#   worker   running
#   updater  running
#   caddy    running             (phương án C: không có caddy)
#   cloudflared running (healthy) <- chỉ phương án D
#   backup   running
docker compose logs --tail=50 migrate web
docker compose logs -f caddy        # phương án A: đợi dòng "certificate obtained successfully" rồi Ctrl+C
docker compose logs --tail=30 cloudflared   # phương án D: có dòng "Registered tunnel connection"
curl -fsS https://mcp.congty.vn/api/health && echo " <- web OK"
```

### 7.1 Tạo admin đầu tiên
```bash
grep '^SETUP_TOKEN=' .env
```
Mở `https://mcp.congty.vn/setup`, nhập `SETUP_TOKEN`, tên, email, mật khẩu mạnh. Trang `/setup` tự khoá khi đã có người dùng. (Không dùng trình duyệt: `docker compose run --rm web node dist/cli.mjs create-admin --email ban@congty.vn` - mật khẩu tạm in ra 1 lần.)

### 7.2 Bảo mật tài khoản ngay sau khi cài
1. Đăng nhập → bật **2FA** cho admin (quét QR bằng ứng dụng TOTP, lưu 10 mã dự phòng ở nơi an toàn).
2. **Cài đặt → Bảo mật → bật "Bắt buộc 2FA cho quản trị viên"**. Mặc định 2FA là tuỳ chọn; trên máy chủ thật nên bắt buộc với admin.
3. **Cài đặt → Cập nhật**: dòng trạng thái dịch vụ cập nhật phải là **Đang hoạt động** (heartbeat < 90 giây). Bấm **Kiểm tra ngay**: phải thấy phiên bản mới nhất (vd `1.0.0`), không báo lỗi token.
4. Kiểm tra HTTPS: `curl -sI https://mcp.congty.vn | grep -i strict-transport` và chấm điểm ở <https://www.ssllabs.com/ssltest/> (kỳ vọng A hoặc A+).

---

## 8. Phương án A - Caddy tự cấp HTTPS (mặc định)

**Khi nào chọn:** mặc định cho mọi cài đặt mới, VPS có IP công khai.

```
Khách ──HTTPS──► VPS:443 caddy (Let's Encrypt, tự gia hạn) ──HTTP──► web:3000
                       X-Forwarded-For = IP kết nối tới Caddy (ghi đè mọi giá trị khách gửi)
```

**Cấu hình:** không cần gì thêm. `.env` có `CADDY_REPLICAS=1`, `CADDY_CLIENT_IP=direct`, `CADDY_TLS=auto` (hoặc không có các dòng này - giá trị mặc định giống nhau). File liên quan: `Caddyfile`, `deploy/caddy/client-ip-direct.caddy`, `deploy/caddy/tls-auto.caddy`.

**Các bước:** mục 3 → 7. Caddy tự xin chứng chỉ ở lần khởi động đầu (cần DNS A đúng + cổng 80/443 mở từ Internet), tự gia hạn trước hạn, lưu ở volume `caddy_data`.

**Kiểm tra**
```bash
curl -sI http://mcp.congty.vn | head -3       # 308 Permanent Redirect -> https://
curl -sI https://mcp.congty.vn | grep -iE '^(HTTP|strict-transport|x-frame|x-content)'
docker compose logs caddy | grep -iE 'certificate obtained|error' | tail
```

**Lỗi thường gặp**
| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Log Caddy `challenge failed`, `timeout during connect` | DNS chưa trỏ đúng, cổng 80 bị chặn (UFW, Security Group của nhà cung cấp) | `dig +short A mcp.congty.vn`; mở 80/443 ở cả 2 tường lửa; `docker compose restart caddy` |
| Log `too many failed authorizations` / `rateLimited` | Let's Encrypt giới hạn **5 lần xác thực lỗi / giờ / tên miền** và **5 chứng chỉ trùng / 7 ngày** | Sửa nguyên nhân, đợi 1 giờ. Không xoá volume `caddy_data` liên tục |
| Trình duyệt báo chứng chỉ không hợp lệ ngay sau khi chạy | Caddy chưa xin xong | Đợi 1-2 phút, xem log |
| 502 Bad Gateway | `web` chưa healthy hoặc lỗi | Mục 13.3 |

Let's Encrypt đã **ngừng gửi email nhắc hết hạn** từ 04/06/2025: hãy theo dõi bằng công cụ giám sát (mục 13.1). Từ 02/2027 chứng chỉ Let's Encrypt chỉ còn 64 ngày (45 ngày từ 02/2028): Caddy tự xử lý, không cần làm gì.

---

## 9. Phương án B - Cloudflare

**Khi nào chọn:** DNS đã ở Cloudflare, cần ẩn IP VPS/WAF/chống DDoS. Chấp nhận giới hạn 125 giây mỗi request.

```
Khách ──HTTPS──► Cloudflare edge ──HTTPS (Full strict, chứng chỉ Origin CA)──► VPS:443 caddy ──► web:3000
                 thêm CF-Connecting-IP = IP khách        Caddy CHỈ tin CF-Connecting-IP khi kết nối đến
                                                         từ dải IP Cloudflare, rồi ghi đè X-Forwarded-For
```

### 9.1 Vì sao phải cấu hình IP thật
Cloudflare **giữ nguyên** `X-Forwarded-For` khách tự gửi và chỉ nối thêm vào bên phải (developers.cloudflare.com, "Cloudflare HTTP headers"). Nếu để mặc định, app (tin hop đầu) sẽ nhận IP do kẻ tấn công tự khai; còn nếu không tin Cloudflare thì app thấy **mọi khách là IP của Cloudflare**: một kẻ đoán mật khẩu làm khoá đăng nhập của tất cả mọi người, giới hạn MCP theo IP gộp chung, allowlist IP của MCP vô dụng. Cấu hình của dự án:
- `deploy/caddy/client-ip-cloudflare.caddy`: `trusted_proxies static <dải IP Cloudflare>` + `client_ip_headers CF-Connecting-IP` (header Cloudflare đặt, chỉ chứa đúng 1 IP).
- `Caddyfile`: `header_up X-Forwarded-For {client_ip}` ghi đè header gửi vào app. Đã kiểm thử: khách gửi `X-Forwarded-For: 6.6.6.6` thì app vẫn nhận đúng IP trong `CF-Connecting-IP`; kết nối thẳng không qua dải Cloudflare thì header giả bị bỏ qua.

Danh sách IP Cloudflare đi kèm repo (15 dải IPv4 + 7 dải IPv6, lấy từ <https://www.cloudflare.com/ips-v4> và `/ips-v6` ngày 2026-10-03). Cập nhật định kỳ (vài tháng một lần):
```bash
sh deploy/cloudflare/update-cloudflare-ips.sh && docker compose restart caddy
```

### 9.2 Cấu hình Cloudflare (dashboard)
1. **DNS → Records**: bản ghi `A` `ads` → IP VPS, **Proxy status: Proxied** (mây cam). Không tạo AAAA trỏ thẳng VPS.
2. **SSL/TLS → Overview**: chọn **Full (strict)**. Không bao giờ dùng *Flexible* (gây vòng lặp chuyển hướng và Cloudflare nói chuyện với VPS bằng HTTP thường).
3. **SSL/TLS → Origin Server → Create Certificate**: "Generate private key and CSR with Cloudflare", key type RSA (2048) hoặc ECC, hostnames `mcp.congty.vn` (hoặc giữ mặc định `*.congty.vn, congty.vn`), validity **15 years**, Key Format **PEM** → Create. Sao chép **Origin Certificate** và **Private Key** (khoá chỉ hiện 1 lần) để dùng ở 9.3. Cloudflare **không gửi thông báo hết hạn** chứng chỉ Origin CA: ghi lịch.
4. **SSL/TLS → Edge Certificates**: bật *Always Use HTTPS*, *Minimum TLS Version* = 1.2.
5. **Caching → Cache Rules → Create rule** "Ads MCP - không cache": khi `Hostname equals mcp.congty.vn` **và** `URI Path does not start with /_next/static/` → **Bypass cache**. (Mặc định Cloudflare không cache HTML/JSON, rule này chặn chắc cho `/mcp/*`, `/api/*`, `/login`, `/setup` và mọi trang động.)
6. **Rules → Configuration Rules → Create rule** "Ads MCP - /mcp": khi `URI Path starts with /mcp/` → **Rocket Loader: Off**, **Email Obfuscation: Off**, **Browser Integrity Check: Off**; nếu gói có mục *Response Body Buffering* thì chọn **None**.
7. **Security → Bots**: **tắt Bot Fight Mode** (gói Free). Cloudflare ghi rõ Bot Fight Mode **không thể** bỏ qua bằng WAF custom rule hay Page Rule, và có thể challenge lưu lượng API. AI client (Claude, ChatGPT, Gemini) không vượt được challenge JavaScript nên sẽ lỗi. Gói Pro trở lên dùng *Super Bot Fight Mode* và tạo rule Skip ở bước 8.
8. **Security → WAF → Custom rules → Create rule** "Ads MCP - skip /mcp": khi `URI Path starts with /mcp/` → action **Skip** → chọn *All managed rules*, *All rate limiting rules*, *All Super Bot Fight Mode rules* (nếu có). Nội dung quảng cáo trong lệnh MCP dễ bị luật WAF nhận nhầm là tấn công; `/mcp/` đã có key 256-bit + giới hạn tốc độ riêng của app.
9. Không bật **Under Attack Mode** cho tên miền này (mọi request MCP sẽ bị challenge).
10. **Video từ Google Drive** (link tạm `https://mcp.congty.vn/dl/<token>/<tên file>`, chỉ dùng khi bật tính năng Google Drive): máy chủ Meta/TikTok tự tải video từ đường dẫn này nên nó cần được đối xử **giống `/mcp/`**: thêm điều kiện `or URI Path starts with /dl/` vào Configuration Rule ở bước 6 (Browser Integrity Check: Off; *Response Body Buffering* = None nếu gói có) và vào WAF custom rule **Skip** ở bước 8 (gói Pro trở lên); Bot Fight Mode (bước 7) và Under Attack Mode (bước 9) phải tắt. **Không** tạo rule "Cache Everything" cho `/dl/*` (app trả `Cache-Control: no-store`; Cache Rule ở bước 5 đã bypass). Giới hạn 100 MB của Cloudflare chỉ áp cho **request**, không cho phản hồi, nên video lớn vẫn đi qua được (chưa thử thật với video 200–500 MB). Link tạm có token 256-bit, hết hạn 60 phút, giới hạn lượt tải và luồng riêng của app.

### 9.3 Cấu hình máy chủ
```bash
cd /opt/ads-mcp
mkdir -p deploy/caddy/certs && chmod 700 deploy/caddy/certs
nano deploy/caddy/certs/origin.pem          # dán Origin Certificate (từ -----BEGIN CERTIFICATE-----)
nano deploy/caddy/certs/origin.key          # dán Private Key
chmod 600 deploy/caddy/certs/origin.key
openssl x509 -in deploy/caddy/certs/origin.pem -noout -subject -enddate   # kiểm tra
```
Sửa `.env` (hoặc tạo mới bằng `--ssl cloudflare`):
```ini
CADDY_CLIENT_IP=cloudflare
CADDY_TLS=cloudflare-origin
```
Áp dụng:
```bash
docker compose up -d --no-build             # tạo lại caddy với biến mới
docker compose logs --tail=30 caddy         # không có lỗi "loading certificates"
```
Thư mục `deploy/caddy/certs/` đã nằm trong `.gitignore` (không bị commit, không bị `git pull` ghi đè).

### 9.4 Kiểm tra
```bash
curl -sI https://mcp.congty.vn | grep -iE '^(HTTP|server|cf-ray|strict-transport)'   # có cf-ray, server: cloudflare
curl -s https://mcp.congty.vn/api/health
```
Đăng nhập web với 1 mật khẩu sai, rồi xem **Nhật ký → Nhật ký nhân sự**: cột IP phải là **IP mạng của bạn** (so với <https://www.cloudflare.com/cdn-cgi/trace>, dòng `ip=`), **không** phải IP dạng `172.64.x.x`/`104.x.x.x` của Cloudflare.

### 9.5 Chặn truy cập thẳng vào VPS: Authenticated Origin Pulls (khuyến nghị)
Kẻ biết IP VPS có thể gọi thẳng, bỏ qua WAF của Cloudflare. AOP (mTLS) bắt Cloudflare xuất trình chứng chỉ client, Caddy từ chối mọi kết nối HTTPS khác ngay ở bước bắt tay TLS. Áp dụng được cho mọi gói, cần SSL Full trở lên.
```bash
cd /opt/ads-mcp
curl -fsSL https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem \
  -o deploy/caddy/certs/cloudflare-origin-pull-ca.pem
openssl x509 -in deploy/caddy/certs/cloudflare-origin-pull-ca.pem -noout -subject -enddate
#   subject=... CN = origin-pull.cloudflare.net ; notAfter=Nov  1 ... 2029 GMT
```
1. Cloudflare: **SSL/TLS → Origin Server → Authenticated Origin Pulls → Global → On**. **Bật trước** khi đổi Caddy, nếu không mọi truy cập qua Cloudflare sẽ lỗi 525.
2. `.env`: `CADDY_TLS=cloudflare-origin-aop` → `docker compose up -d --no-build`.
3. Kiểm tra: truy cập qua tên miền vẫn bình thường; gọi thẳng IP phải bị từ chối:
   ```bash
   curl -vk --resolve mcp.congty.vn:443:<IP_VPS> https://mcp.congty.vn/api/health   # lỗi TLS (certificate required) = đúng
   ```

Giới hạn: chứng chỉ "Global" của Cloudflare **dùng chung cho mọi khách hàng Cloudflare**, nên chỉ chứng minh request đi qua mạng Cloudflare (người khác vẫn có thể trỏ zone Cloudflare của họ vào IP của bạn). Muốn chặt hơn: AOP *zone-level* với chứng chỉ riêng (Cloudflare docs "Zone-level AOP"), rồi thay file CA tương ứng; phương án này chưa được kiểm thử với dự án. AOP **không** dùng được với Cloudflare Tunnel.

### 9.6 (Nâng cao) Chỉ cho dải IP Cloudflare vào cổng 80/443 bằng `DOCKER-USER`
UFW không chặn được cổng Docker publish (mục 3.5); tài liệu Docker hướng dẫn đặt luật vào chain `DOCKER-USER`. Chỉ làm nếu đã quen iptables, và luật **không tự lưu qua khởi động lại** (cần `iptables-persistent`). Phần lớn trường hợp AOP (9.5) là đủ. Ví dụ IPv4 (thay `eth0` bằng card mạng công khai, xem `ip -br addr`):
```bash
sudo iptables -N ADSMCP-CF 2>/dev/null || sudo iptables -F ADSMCP-CF
for ip in $(curl -fsSL https://www.cloudflare.com/ips-v4); do sudo iptables -A ADSMCP-CF -s "$ip" -j RETURN; done
sudo iptables -A ADSMCP-CF -j DROP
sudo iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j ADSMCP-CF
sudo iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j ADSMCP-CF
```
(Làm tương tự với `ip6tables` và `ips-v6` nếu VPS có IPv6. Chế độ nftables của Docker 29 còn thử nghiệm và không có chain `DOCKER-USER`.)

### 9.7 Giới hạn thời gian 125 giây và MCP
- Cloudflare cắt request nếu origin không gửi dữ liệu trong **125 giây** giữa hai lần đọc (lỗi **524**); chỉ gói Enterprise tăng được. Phản hồi `text/event-stream` (SSE) của MCP không bị Cloudflare buffer.
- Lệnh MCP thường xong trong vài giây; app tự cắt mỗi lần gọi nền tảng sau 60 giây. Lệnh rất nặng (báo cáo nhiều tài khoản, khoảng ngày dài) có thể chạm 125 giây: yêu cầu AI chia nhỏ (ít tài khoản hơn, khoảng ngày ngắn hơn).
- **Không** tách được sub-domain DNS-only riêng cho MCP: app chỉ nhận MCP khi `Host` đúng `APP_DOMAIN`.
- Nếu thường xuyên gặp 524: chuyển cả tên miền sang **DNS only** (mây xám). Khi đó trình duyệt không tin chứng chỉ Origin CA, nên trước đó phải đổi sang chứng chỉ Let's Encrypt (9.8) hoặc quay về phương án A.

### 9.8 Biến thể: Cloudflare + chứng chỉ Let's Encrypt của Caddy
Giữ `CADDY_CLIENT_IP=cloudflare` nhưng `CADDY_TLS=auto`. Ưu điểm: bật/tắt mây cam bất cứ lúc nào mà không lỗi chứng chỉ. Điều kiện: Caddy phải gia hạn được bằng thử thách HTTP-01 qua cổng 80 **qua Cloudflare** (Cloudflare chế độ Full nối tới origin bằng HTTP khi khách dùng HTTP), nên **phải tắt "Always Use HTTPS"** ở Cloudflare (Cloudflare chuyển hướng cả đường dẫn `/.well-known/acme-challenge/`); Caddy vẫn tự chuyển HTTP sang HTTPS. Lần xin đầu tiên nên để DNS only, đợi Caddy lấy xong chứng chỉ rồi mới bật mây cam. **Chưa kiểm chứng trên Cloudflare thật**; khuyến nghị dùng Origin CA (9.2-9.3).

### 9.9 Lỗi thường gặp
| Mã | Nghĩa (Cloudflare) | Thường do | Xử lý |
|---|---|---|---|
| 521 | Origin từ chối kết nối | Caddy không chạy, tường lửa chặn IP Cloudflare | `docker compose ps caddy`, `docker compose logs caddy`, kiểm tra 9.6 |
| 522 | Hết thời gian kết nối tới origin | Security Group/UFW chặn 443, VPS quá tải | Mở 443, kiểm tra tải |
| 524 | Origin không phản hồi trong 125 giây | Lệnh MCP quá dài, web treo | 9.7; `docker compose logs web` |
| 525 | Bắt tay SSL thất bại | Bật `cloudflare-origin-aop` nhưng chưa bật AOP ở Cloudflare; `CADDY_TLS=auto` mà Caddy chưa có chứng chỉ | Bật AOP hoặc quay về `cloudflare-origin` |
| 526 | Chứng chỉ origin không hợp lệ | Full (strict) với chứng chỉ sai tên miền/hết hạn, quên đặt `CADDY_TLS=cloudflare-origin` | Kiểm tra 9.3 |
| Vòng lặp chuyển hướng | SSL mode *Flexible* | Đổi sang Full (strict) |
| AI báo lỗi 403/challenge khi gọi MCP | Bot Fight Mode, WAF, Under Attack | 9.2 bước 6-9 |
| AI báo Meta/TikTok không tải được video từ Google Drive (video nhỏ qua link `/dl/…`) | Bot Fight Mode, WAF, Browser Integrity Check hoặc Under Attack challenge `/dl/*` | 9.2 bước 10 |
| Nhật ký ghi IP Cloudflare | Thiếu `CADDY_CLIENT_IP=cloudflare` | Sửa `.env` → `docker compose up -d --no-build` |

**Cloudflare Tunnel (cloudflared):** đã được hỗ trợ chính thức thành **phương án D**, mục [10b](#10b-phương-án-d---cloudflare-tunnel). Tunnel đi qua Caddy của dự án (cấu hình `CADDY_CLIENT_IP=tunnel`) nên IP thật được ghi đúng; không dùng file `client-ip-cloudflare.caddy`/AOP của phương án B cho tunnel.

---

## 10. Phương án C - Nginx + Certbot

**Khi nào chọn:** máy chủ đã có Nginx phục vụ site khác, hoặc tổ chức bắt buộc Nginx.

```
Khách ──HTTPS──► Nginx trên máy chủ :443 (chứng chỉ Certbot) ──HTTP──► 127.0.0.1:3000 (container web)
                 X-Forwarded-For = $remote_addr (GHI ĐÈ)
```

**Cơ chế:** `.env` đặt `CADDY_REPLICAS=0` (Compose không chạy container Caddy, nhường 80/443) và `WEB_HOST_PORT=3000` (web publish ra `127.0.0.1:3000`, chỉ máy chủ truy cập được). Các biến này nằm trong `docker-compose.yml`, nên updater (luôn chạy `docker compose -f docker-compose.yml ...`) tạo lại web vẫn giữ cổng: **đừng** dùng file `docker-compose.override.yml` cho việc này, updater không đọc file đó và web sẽ mất cổng sau mỗi lần cập nhật.

### 10.1 Chuẩn bị Ads MCP
```bash
cd /opt/ads-mcp
# cài mới: sh scripts/gen-secrets.sh --domain mcp.congty.vn --email it@congty.vn --ssl nginx
# đã có .env: sửa 2 dòng
sed -i 's/^CADDY_REPLICAS=.*/CADDY_REPLICAS=0/; s/^WEB_HOST_PORT=.*/WEB_HOST_PORT=3000/' .env
grep -E '^(CADDY_REPLICAS|WEB_HOST_PORT)=' .env      # nếu không có dòng nào: thêm bằng tay
docker compose up -d --no-build                      # đang chạy Caddy thì container caddy bị gỡ
docker compose ps                                     # web: 127.0.0.1:3000->3000/tcp, không còn caddy
curl -fsS http://127.0.0.1:3000/api/health && echo " <- web OK"
```

### 10.2 Cài Nginx và Certbot
Ubuntu 24.04 (Nginx 1.24 của distro, có sẵn module realip; Certbot bản snap theo hướng dẫn chính thức certbot.eff.org):
```bash
sudo apt -y install nginx
sudo apt-get remove certbot 2>/dev/null; sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot
certbot --version
```
Debian (không muốn dùng snap): `sudo apt -y install nginx certbot python3-certbot-nginx`.

UFW áp dụng bình thường với Nginx (tiến trình máy chủ): giữ `80/tcp` và `443/tcp` đã mở ở mục 3.5.

### 10.3 Xin chứng chỉ
DNS A phải trỏ đúng VPS. Xin chứng chỉ khi Nginx vẫn đang chạy site mặc định (Certbot tự chèn tạm cấu hình xác thực rồi gỡ):
```bash
sudo certbot certonly --nginx -d mcp.congty.vn -m it@congty.vn --agree-tos --no-eff-email \
  --deploy-hook "systemctl reload nginx"
sudo ls /etc/letsencrypt/live/mcp.congty.vn/          # fullchain.pem privkey.pem ...
```
Dùng `certonly` để Certbot **không sửa** file cấu hình của dự án; `--deploy-hook` được lưu lại và tự reload Nginx sau mỗi lần gia hạn (nếu không, Nginx vẫn dùng chứng chỉ cũ đến khi reload).

### 10.4 Cài cấu hình Nginx của dự án
```bash
sudo cp /opt/ads-mcp/deploy/nginx/ads-mcp.conf /etc/nginx/sites-available/ads-mcp.conf
sudo sed -i 's/mcp\.example\.com/mcp.congty.vn/g' /etc/nginx/sites-available/ads-mcp.conf
sudo ln -sf /etc/nginx/sites-available/ads-mcp.conf /etc/nginx/sites-enabled/ads-mcp.conf
sudo rm -f /etc/nginx/sites-enabled/default          # tuỳ chọn: bỏ trang chào mặc định
sudo nginx -t && sudo systemctl reload nginx
```
Nội dung chính của `deploy/nginx/ads-mcp.conf` (đã kiểm `nginx -t` trên Nginx 1.24 của Ubuntu 24.04 và 1.30):
- Cổng 80 chỉ chuyển hướng 301 sang HTTPS.
- `proxy_set_header X-Forwarded-For $remote_addr;` **ghi đè** header. **Không** đổi thành `$proxy_add_x_forwarded_for` (biến đó nối thêm vào giá trị khách gửi, app tin hop đầu nên khách tự khai được IP bất kỳ, né khoá đăng nhập và allowlist IP MCP). Đã kiểm thử: khách gửi `X-Forwarded-For: 6.6.6.6`, app vẫn nhận IP thật.
- `Host`, `X-Forwarded-Proto https`, `X-Forwarded-Host` như Caddy (app kiểm tra Host cho MCP và Origin cho server action).
- `location /mcp/`: `proxy_buffering off` (SSE), `client_max_body_size 1m`, `proxy_read_timeout 600s`, không gzip, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY` (ẩn bản của app rồi đặt lại 1 lần, không nhân đôi header).
- **Che key MCP trong access log** (`/var/log/nginx/ads-mcp.access.log`, định dạng JSON): đường dẫn và Referer thành `/mcp/[redacted]`; mã uỷ quyền TikTok trong query thành `auth_code=[redacted]`. Log lỗi của `/mcp/` chỉ ghi mức `crit` vì error log của Nginx in cả dòng request (có key) và không che được.
- Không bật `ssl_stapling` (Let's Encrypt đã ngừng OCSP từ 08/2025). `ssl_ciphers` theo mức "intermediate" của Mozilla (TLS 1.2 chỉ AEAD + ECDHE).

Tuỳ chọn: `deploy/nginx/default-deny.conf` từ chối mọi request không gửi tới đúng tên miền (quét theo IP, `Host` lạ; cổng 443 từ chối bắt tay TLS nên không lộ chứng chỉ). **Chỉ** bật khi không site nào khác trên máy chủ khai báo `default_server` (hai `default_server` cùng cổng làm `nginx -t` lỗi); cách cài ghi ở đầu file.

Nếu Nginx đang có `log_format`/`upstream` khác tên trùng (`adsmcp_json`, `adsmcp_web`) thì đổi tên. Access log mặc định `/var/log/nginx/access.log` của các site khác không bị ảnh hưởng.

### 10.5 Gia hạn tự động và kiểm tra
```bash
sudo certbot renew --dry-run                     # phải "Congratulations, all simulated renewals succeeded"
systemctl list-timers | grep -i certbot          # snap.certbot.renew.timer (hoặc certbot.timer với apt)
curl -sI https://mcp.congty.vn | grep -iE '^(HTTP|strict-transport)'
sudo tail -n 3 /var/log/nginx/ads-mcp.access.log # "uri":"/mcp/[redacted]..." nếu có lượt gọi MCP
```
Let's Encrypt không còn gửi email nhắc hết hạn: theo dõi bằng công cụ giám sát (mục 13.1).

### 10.6 Nginx + Cloudflare
Nếu tên miền bật mây cam ở Cloudflare:
1. Làm 9.2 (DNS proxied, Full (strict), cache/bot/WAF). Với chứng chỉ: hoặc giữ Certbot (phải **tắt Always Use HTTPS** ở Cloudflare để gia hạn HTTP-01 qua cổng 80, xem 9.8), hoặc dùng Origin CA: lưu file vào `/etc/ssl/ads-mcp/origin.pem` + `origin.key` (`chmod 600`) và sửa 2 dòng `ssl_certificate`/`ssl_certificate_key` trỏ tới đó.
2. **Bắt buộc lấy IP thật:** bỏ dấu `#` ở **cả 2** dòng `# include /opt/ads-mcp/deploy/nginx/cloudflare-realip.conf;` trong `/etc/nginx/sites-available/ads-mcp.conf` (sửa đường dẫn nếu dự án không ở `/opt/ads-mcp`). File này gồm `set_real_ip_from <dải IP Cloudflare>` + `real_ip_header CF-Connecting-IP`: chỉ khi kết nối đến từ Cloudflare thì `$remote_addr` mới được thay bằng IP khách, sau đó `X-Forwarded-For $remote_addr` gửi IP đúng vào app.
3. `sudo nginx -t && sudo systemctl reload nginx`, kiểm tra như 9.4.
4. Chặn truy cập thẳng: với Nginx, UFW **có tác dụng**, nên có thể chỉ cho dải IP Cloudflare vào 80/443:
   ```bash
   sudo ufw delete allow 80/tcp; sudo ufw delete allow 443/tcp
   for ip in $(curl -fsSL https://www.cloudflare.com/ips-v4) $(curl -fsSL https://www.cloudflare.com/ips-v6); do
     sudo ufw allow proto tcp from "$ip" to any port 80,443
   done
   sudo ufw status numbered
   ```
   (Khi Cloudflare đổi dải IP phải chạy lại; AOP với Nginx: `ssl_client_certificate <ca.pem>; ssl_verify_client on;` - chưa kiểm thử.)
5. Cập nhật dải IP: `sh deploy/cloudflare/update-cloudflare-ips.sh && sudo nginx -t && sudo systemctl reload nginx`.

### 10.7 Lỗi thường gặp
| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `nginx -t`: `cannot load certificate` | Chưa chạy 10.3 hoặc sai tên miền trong file | Kiểm tra `/etc/letsencrypt/live/<tên miền>/` |
| `bind() to 0.0.0.0:80 failed (Address already in use)` | Container Caddy vẫn chạy | `CADDY_REPLICAS=0` → `docker compose up -d --no-build` |
| 502 Bad Gateway | Web không chạy hoặc không publish `127.0.0.1:3000` | `docker compose ps web`; `curl http://127.0.0.1:3000/api/health`; kiểm tra `WEB_HOST_PORT=3000` |
| Sau khi bấm Cập nhật web lỗi 502 | Cổng do file override (updater không đọc) | Chuyển cấu hình cổng vào `.env` như 10.1 |
| Nhật ký ghi IP `127.0.0.1` hoặc IP Cloudflare | Thiếu `X-Forwarded-For $remote_addr` hoặc thiếu include realip (10.6) | Dùng đúng file của dự án |
| `certbot renew --dry-run` lỗi qua Cloudflare | Always Use HTTPS đang bật | Tắt, hoặc dùng Origin CA |

---

## 10b. Phương án D - Cloudflare Tunnel

**Khi nào chọn:** VPS không có IP công khai hoặc không mở được cổng 80/443 (sau NAT, mạng công ty, máy chủ đặt tại văn phòng), hoặc muốn VPS **không mở cổng vào nào** ngoài SSH. Tên miền phải dùng DNS của Cloudflare. Chấp nhận giới hạn 125 giây mỗi request như phương án B.

```
Khách ──HTTPS──► Cloudflare edge ══ tunnel mã hoá (cloudflared tự kết nối RA, cổng 7844) ══► cloudflared (container)
                 đặt CF-Connecting-IP = IP khách                                                  │ HTTP trong mạng
                                                                                                  ▼ Docker nội bộ
                     caddy:80 (site http://APP_DOMAIN, không chứng chỉ; trên máy chủ chỉ mở ở 127.0.0.1)
                     tin CF-Connecting-IP vì kết nối đến từ mạng riêng của Docker,
                     GHI ĐÈ X-Forwarded-For = IP khách ──► web:3000
VPS không mở 80/443 ra Internet; tường lửa chỉ cần SSH.
```

### 10b.1 Thiết kế và lý do
- **Tunnel vẫn đi qua Caddy, không trỏ thẳng vào `web:3000`.** Cloudflare giữ nguyên `X-Forwarded-For` khách tự gửi và chỉ nối thêm IP vào bên phải; cloudflared không sửa header này. App chỉ tin hop đầu của `X-Forwarded-For`, nên nếu trỏ thẳng `web:3000` thì kẻ tấn công tự khai được IP bất kỳ (né khoá đăng nhập, né allowlist IP của MCP). Caddy ở chế độ tunnel (`deploy/caddy/client-ip-tunnel.caddy`) lấy IP từ `CF-Connecting-IP` (Cloudflare đặt, chỉ 1 IP) rồi ghi đè `X-Forwarded-For`. Đã kiểm thử: gửi `CF-Connecting-IP: 1.2.3.4` kèm `X-Forwarded-For: 6.6.6.6, ...` thì app nhận `1.2.3.4`. Caddy cũng giữ các lớp bảo vệ chung với A/B: che key MCP trong log, header bảo mật, giới hạn body `/mcp/` 1 MB, không buffer SSE.
- **Chỉ tin kết nối từ mạng riêng.** Caddy chỉ tin `CF-Connecting-IP` khi kết nối đến từ dải mạng riêng (mạng Docker nội bộ, nơi có cloudflared). Điều này an toàn vì ở phương án D Caddy **không** nhận kết nối từ Internet: `CADDY_HTTP_PORT_BIND=127.0.0.1:` và `CADDY_HTTPS_PORT_BIND=127.0.0.1:` chỉ mở trên loopback của máy chủ, cổng ngẫu nhiên. Đã kiểm thử: kết nối từ dải ngoài mạng riêng gửi `CF-Connecting-IP` giả thì bị bỏ qua. **Không** dùng `CADDY_CLIENT_IP=tunnel` khi Caddy còn mở 80/443 ra Internet.
- **Host giữ nguyên.** cloudflared gửi `Host` = tên miền công khai (khi route không đặt *HTTP Host Header*). Caddy chỉ phục vụ site `http://APP_DOMAIN` và app chỉ nhận MCP khi `Host` = `APP_DOMAIN`, nên **Service URL phải là `http://caddy:80` và không đặt HTTP Host Header**.
- **HTTPS do Cloudflare lo.** Caddy không xin chứng chỉ (`CADDY_TLS=tunnel`, `CADDY_SITE_SCHEME=http://`). Đoạn Cloudflare tới VPS đi trong tunnel mã hoá; đoạn cloudflared tới Caddy là HTTP trong mạng Docker của chính máy chủ. Khách mở `http://` được Caddy chuyển sang `https://` (dựa vào `X-Forwarded-Proto` do Cloudflare đặt); bật thêm *Always Use HTTPS* ở 10b.7.
- **Updater chạy y nguyên:** chỉ thay `web` + `worker`, không tạo lại `caddy`/`cloudflared`, tunnel không bị ngắt khi cập nhật (web gián đoạn 1-2 phút như các phương án khác).
- **Mặc định tắt ở A/B/C:** service `cloudflared` có `replicas: 0` (giống cách tắt Caddy ở phương án C), không chạy container nào. `docker compose pull` vẫn kéo image của nó (khoảng 29 MB nén, ~98 MB trên đĩa) ở mọi phương án.

### 10b.2 Điều kiện
- Tài khoản Cloudflare (gói Free đủ dùng) và tên miền đã chuyển nameserver về Cloudflare (zone **Active**). Tunnel chỉ tạo được route cho tên miền nằm trong cùng tài khoản.
- VPS đi ra Internet được cổng **7844 TCP và UDP** (QUIC; tự lùi về HTTP/2 qua TCP nếu UDP bị chặn) và **443** (`api.cloudflare.com`). Hầu hết VPS mặc định cho phép mọi kết nối ra.
- Tên miền 1 cấp như `mcp.congty.vn` được chứng chỉ Universal SSL miễn phí của Cloudflare phủ sẵn. Tên nhiều cấp (vd `ads.mkt.congty.vn`) cần Advanced Certificate (trả phí).

### 10b.3 Tạo tunnel trong dashboard Cloudflare
Giao diện Cloudflare đổi khá thường xuyên; tên menu dưới đây theo tài liệu chính thức (developers.cloudflare.com, truy cập 2026-10-03).
1. Đăng nhập <https://dash.cloudflare.com>, chọn tài khoản → **Networking → Tunnels → Create a tunnel** (giao diện Zero Trust cũ: **Networks → Connectors → Cloudflare Tunnels → Create a tunnel → Cloudflared**). Đặt tên, ví dụ `ads-mcp-vps`, bấm **Create Tunnel**.
2. Màn hình cài đặt hiện lệnh cài cho từng hệ điều hành. Chọn **Docker**, lệnh có dạng `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJ...`. **Không chạy lệnh này** (dự án đã có service `cloudflared` trong `docker-compose.yml`). Chỉ sao chép **token**: chuỗi dài bắt đầu bằng `eyJ` ngay sau `--token`. Cần lấy lại sau này: **Networking → Tunnels** → chọn tunnel → **Add a replica**, sao chép lại lệnh.
3. Thêm route: chọn tunnel → tab **Routes → Add route → Published application** (giao diện cũ: **Public Hostname → Add a public hostname**):

   | Trường | Giá trị |
   |---|---|
   | Subdomain | `ads` |
   | Domain | `congty.vn` (Subdomain + Domain phải đúng bằng `APP_DOMAIN`) |
   | Path | để trống |
   | Service URL | `http://caddy:80` (kiểu **HTTP**, địa chỉ `caddy:80`) |

   Mục *Additional application settings* giữ **mặc định**: không đặt *HTTP Host Header*, không bật *No TLS Verify* (không cần với HTTP), không bật *Protect with Access* (xem 10b.8).
4. Lưu. Cloudflare tự tạo bản ghi DNS **CNAME** `ads` → `<UUID>.cfargotunnel.com`. Nếu báo *"An A, AAAA, or CNAME record with that host already exists"*: vào **DNS → Records**, xoá bản ghi `ads` cũ (vd bản ghi A trỏ VPS của phương án A/B) rồi thêm route lại.

> [!CAUTION]
> **Token là quyền chạy tunnel.** Ai có token đều chạy được connector cho tunnel này và nhận một phần lưu lượng của tên miền. Không gửi token qua chat/email, không commit, không chụp màn hình. Nghi bị lộ: dùng chức năng xoay token (**Rotate token**) trong trang tunnel (tài liệu Cloudflare "Tunnel tokens"), rồi cập nhật `.env` như 10b.4 và chạy `docker compose up -d --no-build cloudflared`.

### 10b.4 Cấu hình máy chủ (`.env`)
**Cài mới** (sau mục 6.1-6.2):
```bash
cd /opt/ads-mcp
sh scripts/gen-secrets.sh --domain mcp.congty.vn --ssl tunnel
echo "UPDATER_DOCKER_CONFIG=$HOME/.docker" >> .env
chmod 600 .env
```
`--email` không bắt buộc với phương án D (Caddy không xin chứng chỉ). Script đặt sẵn `CADDY_CLIENT_IP=tunnel`, `CADDY_TLS=tunnel`, `CADDY_SITE_SCHEME=http://`, `CADDY_HTTP_PORT_BIND=127.0.0.1:`, `CADDY_HTTPS_PORT_BIND=127.0.0.1:`, `CLOUDFLARED_REPLICAS=1` và để trống `TUNNEL_TOKEN` (script không sinh token).

**Chuyển từ phương án A/B/C đang chạy:** lấy cấu hình mới trước (`git pull`, giống 11.2 bước 2), rồi đặt các biến (dòng nào chưa có thì được thêm vào cuối):
```bash
cd /opt/ads-mcp
git pull --ff-only
cp -p .env .env.before-tunnel                       # bản dự phòng (chứa secret: giữ quyền 600)
for kv in CADDY_REPLICAS=1 CADDY_CLIENT_IP=tunnel CADDY_TLS=tunnel CADDY_SITE_SCHEME=http:// \
          CADDY_HTTP_PORT_BIND=127.0.0.1: CADDY_HTTPS_PORT_BIND=127.0.0.1: WEB_HOST_PORT= CLOUDFLARED_REPLICAS=1; do
  k=${kv%%=*}
  if grep -q "^$k=" .env; then sed -i "s|^$k=.*|$kv|" .env; else echo "$kv" >> .env; fi
done
grep -q '^TUNNEL_TOKEN=' .env || echo 'TUNNEL_TOKEN=' >> .env
```

**Dán token:** `nano .env`, tìm dòng `TUNNEL_TOKEN=` và dán token ngay sau dấu `=` (một dòng, không dấu cách, không ngoặc kép), lưu lại. Kiểm tra (không in token):
```bash
grep -c '^TUNNEL_TOKEN=eyJ' .env                                  # phải ra 1
grep -E '^(CADDY_[A-Z_]+|WEB_HOST_PORT|CLOUDFLARED_[A-Z_]+)=' .env
```
Kết quả lệnh thứ hai (thứ tự có thể khác):
```ini
CADDY_REPLICAS=1
CADDY_CLIENT_IP=tunnel
CADDY_TLS=tunnel
CADDY_SITE_SCHEME=http://
CADDY_HTTP_PORT_BIND=127.0.0.1:
CADDY_HTTPS_PORT_BIND=127.0.0.1:
WEB_HOST_PORT=
CLOUDFLARED_REPLICAS=1
```
Mạng của VPS chặn UDP: thêm dòng `CLOUDFLARED_PROTOCOL=http2`.

### 10b.5 Khởi chạy
```bash
docker compose pull                 # kéo thêm cloudflare/cloudflared:2026.10.7
docker compose up -d --no-build     # đang chạy A/B: caddy được tạo lại và thôi mở 80/443
docker compose ps
#   caddy        running             127.0.0.1:<cổng ngẫu nhiên>->80/tcp ...  (không còn 0.0.0.0:80, :443)
#   cloudflared  running (healthy)   <- healthy sau khoảng 20-30 giây
docker compose logs --tail=30 cloudflared
```
- Log đúng có các dòng `Registered tunnel connection connIndex=0` … `connIndex=3` (cloudflared mở 4 kết nối tới ít nhất 2 trung tâm dữ liệu), kèm `protocol=quic` hoặc `http2`. Bảng kiểm tra lúc khởi động phải toàn `PASS`. Trong dashboard, tunnel chuyển trạng thái **Healthy**.
- Log Caddy có cảnh báo `server is listening only on the HTTP port, so no automatic HTTPS will be applied` là **bình thường** ở phương án D.
- Trước đó dùng phương án C (Nginx): gỡ site của dự án khỏi Nginx (`sudo rm /etc/nginx/sites-enabled/ads-mcp.conf && sudo nginx -t && sudo systemctl reload nginx`); Caddy ở phương án D không tranh cổng 80/443 với Nginx.

### 10b.6 Kiểm tra
Trên VPS (đi thẳng vào Caddy, không qua Cloudflare):
```bash
docker compose exec caddy wget -qO- --header "Host: mcp.congty.vn" http://127.0.0.1/api/health && echo " <- caddy -> web OK"
docker compose port caddy 80                          # 127.0.0.1:<cổng> (không phải 0.0.0.0)
sudo ss -tlnp | grep -E ':(80|443)\s' || echo "OK: không có gì nghe cổng 80/443"
```
Từ máy tính của bạn:
```bash
curl -sI https://mcp.congty.vn | grep -iE '^(HTTP|server|cf-ray|strict-transport)'   # server: cloudflare, có cf-ray
curl -s https://mcp.congty.vn/api/health
curl -sI http://mcp.congty.vn | grep -iE '^(HTTP|location)'                           # 301/308 -> https://
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.congty.vn/mcp/khong-ton-tai       # 404 của app (không phải 403/challenge)
```
- **IP thật:** đăng nhập web với 1 mật khẩu sai, xem **Nhật ký → Nhật ký nhân sự**: cột IP phải là IP mạng của bạn (so với <https://www.cloudflare.com/cdn-cgi/trace>, dòng `ip=`), **không** phải `172.x.x.x` (IP container cloudflared) hay IP của Cloudflare.
- **MCP:** tạo 1 MCP, thêm vào Claude/ChatGPT, gọi thử 1 lệnh đọc số liệu.

### 10b.7 Cấu hình Cloudflare cho tên miền
Làm các bước của 9.2 **trừ** bước 1 (DNS: bản ghi CNAME đã do tunnel tạo, đừng đổi sang A) và bước 3 (không cần chứng chỉ Origin CA):
- **SSL/TLS → Edge Certificates:** bật *Always Use HTTPS*, *Minimum TLS Version* = 1.2. Chế độ mã hoá SSL/TLS của zone không ảnh hưởng tới đường tunnel; giữ **Full (strict)**, không chọn *Flexible*.
- Cache Rule bypass, Configuration Rule cho `/mcp/` (Rocket Loader, Email Obfuscation, Browser Integrity Check: Off; *Response Body Buffering* = None nếu gói có), tắt **Bot Fight Mode** (gói Free), WAF custom rule **Skip** cho `/mcp/`, không bật Under Attack Mode: y như 9.2 bước 5-9. Dùng Google Drive: áp cả cho `/dl/` (9.2 bước 10).
- **Không** bật Managed Transform *Remove visitor IP headers*: nó xoá `CF-Connecting-IP`, app sẽ thấy mọi khách là IP của container cloudflared và khoá đăng nhập gộp chung. Nếu bật *Pseudo IPv4*, chọn *Add header*, không chọn *Overwrite headers* (ghi đè IP thật của khách IPv6 bằng IPv4 giả).
- Không cần AOP (9.5) hay luật `DOCKER-USER` (9.6): VPS không mở cổng nào để Cloudflare hay ai khác gọi vào.

### 10b.8 Cloudflare Access cho giao diện web (tuỳ chọn)
Access thêm một lớp đăng nhập của Cloudflare (mã OTP qua email, Google/Microsoft SSO…) **trước** giao diện web: người lạ không chạm được tới trang đăng nhập của app.

**Lợi ích:** chặn dò mật khẩu và khai thác giao diện từ người ngoài; có log truy cập của Cloudflare.

**Rủi ro và giới hạn:**
- AI client (Claude, ChatGPT, Gemini) **không đăng nhập Access được**, nên bắt buộc **Bypass** cho `/mcp/*` và `/.well-known/*` (AI client dò cấu hình OAuth ở `/.well-known/...`; bị chuyển sang trang đăng nhập Access thì kết nối MCP có thể lỗi). `/mcp/*` vẫn được bảo vệ bằng key 256 bit, giới hạn tốc độ và allowlist IP của app. Dùng Google Drive: máy chủ Meta/TikTok cũng không đăng nhập được → **Bypass** thêm `/dl/*` (link tạm video, token 256 bit, hết hạn 60 phút).
- Bypass tắt hoàn toàn Access cho đường dẫn đó và không ghi log Access. *Service Auth* cần service token mà AI client không gửi được.
- Nhân viên đăng nhập 2 lần (Access rồi app). Giám sát `/api/health` từ bên ngoài cần thêm Bypass cho `/api/health`.
- Quên Bypass = MCP ngừng hoạt động với mọi AI. Kiểm tra lại sau mỗi lần sửa policy.

**Các bước** (Zero Trust → **Access controls → Applications**; mọi ứng dụng Access mặc định từ chối):
1. **Create new application → Self-hosted** (tên mới: *Self-hosted and private*) → Public hostname `mcp.congty.vn`, Path để trống → policy **Allow**, Include: *Emails ending in* `@congty.vn` (hoặc danh sách email) → lưu.
2. Ứng dụng thứ hai, cùng hostname, Path `mcp/*` → policy action **Bypass**, Include **Everyone**.
3. Ứng dụng thứ ba, Path `.well-known/*` → **Bypass**, **Everyone** (thêm `api/health` nếu dùng giám sát ngoài).
4. Dùng Google Drive: ứng dụng thứ tư, Path `dl/*` → **Bypass**, **Everyone**.

Đường dẫn cụ thể hơn được ưu tiên và không kế thừa policy của ứng dụng gốc. **Không** bật *Protect with Access* trong cài đặt route của tunnel (cloudflared sẽ đòi JWT của Access cho mọi request, kể cả `/mcp/`). Kiểm tra:
```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://mcp.congty.vn/login                 # 302 tới ...cloudflareaccess.com = Access đang chặn (đúng)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://mcp.congty.vn/mcp/khong-ton-tai     # 404, không chuyển hướng (đã Bypass)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://mcp.congty.vn/.well-known/oauth-protected-resource   # không chuyển hướng tới cloudflareaccess.com
```
**Chưa kiểm chứng** Access với AI client thật; nếu AI không kết nối được, tắt Access (xoá ứng dụng ở bước 1) để khoanh vùng.

### 10b.9 Giới hạn và vận hành
- **125 giây:** Cloudflare cắt request khi origin không gửi dữ liệu trong 125 giây (lỗi 524). Tài liệu Cloudflare không ghi riêng cho tunnel, coi như áp dụng giống phương án B (9.7). Khác B: **không thể** chuyển sang DNS only (VPS không mở cổng). Thường xuyên gặp 524 thì chia nhỏ lệnh hoặc chuyển sang phương án A.
- **SSE:** cloudflared đẩy ngay phản hồi `text/event-stream` (không buffer); Caddy không nén/buffer `/mcp/`.
- **Phụ thuộc Cloudflare:** tunnel hoặc Cloudflare sự cố thì web và MCP cùng ngừng. Theo dõi `https://mcp.congty.vn/api/health` từ bên ngoài (13.1) và trạng thái tunnel trong dashboard.
- **Log:** **không** đặt `TUNNEL_LOGLEVEL=debug` / `--loglevel debug`: mức debug ghi cả URL và header request, lộ key `/mcp/<key>`. Mức mặc định `info` không ghi đường dẫn.
- **Phiên bản cloudflared** được ghim trong `docker-compose.yml` (`cloudflare/cloudflared:2026.10.7`), không tự cập nhật. Bản phát hành mới của Ads MCP có thể nâng phiên bản (ghi chú phát hành sẽ nêu). Áp dụng: `git pull --ff-only && docker compose pull cloudflared && docker compose up -d --no-build cloudflared` (tunnel ngắt vài giây).
- **Một connector là đủ** cho 1 VPS. Không chạy song song lệnh `docker run ... --token` của dashboard: mọi connector cùng tunnel đều nhận lưu lượng.
- **Đổi token** (sau khi Rotate): sửa `TUNNEL_TOKEN` trong `.env` → `docker compose up -d --no-build cloudflared`.
- **Quay về phương án A:** trong Cloudflare xoá route của tunnel và bản ghi CNAME, tạo lại bản ghi A trỏ IP VPS (mục 2), mở lại 80/443 (3.5), rồi:
  ```bash
  for kv in CADDY_CLIENT_IP=direct CADDY_TLS=auto CADDY_SITE_SCHEME= CADDY_HTTP_PORT_BIND=80 CADDY_HTTPS_PORT_BIND=443 CLOUDFLARED_REPLICAS=0; do
    k=${kv%%=*}; sed -i "s|^$k=.*|$kv|" .env
  done
  docker compose up -d --no-build                   # gỡ container cloudflared, Caddy mở lại 80/443 và xin chứng chỉ
  ```

### 10b.10 Lỗi thường gặp
| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Trang lỗi Cloudflare **1033** (*Cloudflare Tunnel error*) hoặc **530** | Không có cloudflared nào kết nối: `CLOUDFLARED_REPLICAS` chưa là `1`, container dừng/khởi động lại liên tục, token sai, mạng chặn 7844 | `docker compose ps cloudflared`; `docker compose logs --tail=50 cloudflared`; xem trạng thái tunnel trong dashboard |
| Log `Provided Tunnel token is not valid` | `TUNNEL_TOKEN` trống, thiếu/thừa ký tự, có dấu cách hoặc ngoặc kép | Dán lại token (10b.3 bước 2, 10b.4) → `docker compose up -d --no-build cloudflared` |
| Log lặp lại `Register tunnel error ... Failed to get tunnel` | Tunnel đã bị xoá hoặc token đã bị xoay (Rotate) | Lấy token hiện tại trong dashboard, dán lại |
| Bảng kiểm tra lúc khởi động có dòng `FAIL` (UDP/TCP Connectivity), tunnel không Healthy | Tường lửa chặn chiều ra 7844 UDP/TCP | Mở chiều ra 7844 (3.5); mạng chỉ cho TCP: `CLOUDFLARED_PROTOCOL=http2` → `docker compose up -d --no-build cloudflared` |
| **502 Bad Gateway** (trang của Cloudflare), log cloudflared `Unable to reach the origin service` | Service URL sai (vd `http://localhost:80`, `https://caddy:443`), container `caddy` không chạy, `web` chưa healthy | Service URL = `http://caddy:80`; `docker compose ps caddy web`; `docker compose logs --tail=50 caddy web` |
| Trang trắng (200, không nội dung) hoặc AI báo 404 khi gọi MCP | `Host` không khớp: route đặt *HTTP Host Header*, hoặc hostname của route khác `APP_DOMAIN` | Bỏ HTTP Host Header; hostname route = `APP_DOMAIN`; thử lệnh `wget` ở 10b.6 |
| `ERR_TOO_MANY_REDIRECTS`; log Caddy cố xin chứng chỉ (`obtaining certificate`, `challenge failed`) | Thiếu `CADDY_SITE_SCHEME=http://` hoặc `CADDY_TLS=tunnel`: Caddy vẫn ở chế độ HTTPS, chuyển hướng request HTTP của cloudflared | Đặt đủ biến ở 10b.4 → `docker compose up -d --no-build` |
| `docker compose up` báo `Bind for 0.0.0.0:80 failed: port is already allocated` | Chưa đổi `CADDY_HTTP_PORT_BIND`/`CADDY_HTTPS_PORT_BIND`, máy chủ có chương trình khác dùng 80/443 | Đặt `127.0.0.1:` cho cả 2 biến |
| Nhật ký ghi IP `172.x.x.x` cho mọi người, mọi người bị khoá đăng nhập cùng lúc | `CADDY_CLIENT_IP` chưa là `tunnel`, hoặc bật *Remove visitor IP headers* | Sửa `.env` → `docker compose up -d --no-build`; tắt managed transform (10b.7) |
| 524 sau khoảng 125 giây | Lệnh MCP quá dài | 9.7, 10b.9 |
| AI báo 403 / challenge / không thêm được connector | Bot Fight Mode, WAF, Under Attack, hoặc Access chưa Bypass `/mcp/*`, `/.well-known/*` | 10b.7, 10b.8 |
| Meta/TikTok không tải được video từ Google Drive (link `/dl/…`) | Bot Fight Mode / WAF / challenge trên `/dl/*`, hoặc Access chưa Bypass `/dl/*` | 9.2 bước 10, 10b.8 |
| Thêm route báo *record already exists* | Còn bản ghi DNS cũ cùng tên | Xoá bản ghi cũ trong **DNS → Records** (10b.3 bước 4) |

Tài liệu xử lý lỗi tunnel của Cloudflare: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/>.

---

## 11. Cập nhật phiên bản

### 11.1 Trong web (khuyến nghị)
Khi Nextgency phát hành bản mới (tag `vX.Y.Z` → GitHub Actions build image + tạo Release), admin thấy thông báo trong web. **Cài đặt → Cập nhật → Cập nhật lên vX.Y.Z** (xác thực lại mật khẩu/2FA). Service `updater`:
1. sao lưu database → `backups/pre-update-<thời gian UTC>.dump` (giữ lại, không tự xoá);
2. `docker pull` image mới, kiểm tra image mang đúng phiên bản và **xác minh chữ ký số** (cosign) do GitHub Actions của Nextgency ký cho đúng tag `vX.Y.Z` - image không có chữ ký (tự build, đẩy tay, bị tráo) bị từ chối, bản đang chạy không bị ảnh hưởng;
3. chạy migration bằng image mới (bản cũ vẫn phục vụ; lỗi thì dừng, không đụng bản đang chạy);
4. ghi `APP_VERSION=X.Y.Z` vào `.env` (bản cũ ở `.env.bak`) rồi thay `web` + `worker`;
5. kiểm tra sức khoẻ tối đa 5 phút; lỗi thì **tự quay về bản cũ**;
6. tự thay chính updater bằng bản mới.

Web gián đoạn khoảng 1-2 phút. Theo dõi trên trang Cập nhật hoặc `docker compose logs -f updater`. Như nhau ở cả 4 phương án: updater chỉ chạy `docker compose -f docker-compose.yml up -d --no-deps web worker`, không tạo lại `caddy` hay `cloudflared` (phương án D: tunnel giữ kết nối suốt quá trình cập nhật).

**Điều kiện để updater chạy được với image riêng tư**
- Trang Cập nhật báo dịch vụ **Đang hoạt động** (`docker compose ps updater` = running). Nếu "Chưa bật": `docker compose logs updater` (thường do `HOST_PROJECT_DIR` sai, thiếu `COMPOSE_PROFILES=updater`, hoặc chưa `docker compose up -d --no-build` sau khi sửa `.env`).
- `docker login ghcr.io` còn hiệu lực ở **đúng thư mục** `UPDATER_DOCKER_CONFIG` (mục 6.2). PAT hết hạn → bước "Tải image" báo lỗi, bản đang chạy không bị ảnh hưởng: đăng nhập lại rồi bấm Cập nhật lần nữa.
- `UPDATE_GITHUB_TOKEN` (token mục 5) còn hạn (repo riêng tư), nếu không web không thấy bản mới.
- Máy chủ đi ra Internet được tới `ghcr.io` và Sigstore (`*.sigstore.dev`) để xác minh chữ ký số. Bị chặn thì bước "Tải image" báo `không xác minh được chữ ký số`. Chỉ khi bắt buộc mới đặt tạm `UPDATER_VERIFY_SIGNATURE=0` trong `.env` (bỏ qua kiểm tra, không khuyến nghị), cập nhật xong thì xoá dòng đó.

> [!IMPORTANT]
> Updater **chỉ đổi image** (`APP_VERSION`). Nó **không** cập nhật `docker-compose.yml`, `Caddyfile`, `deploy/`, script trong thư mục dự án. Khi một bản phát hành đổi các file đó, ghi chú phát hành sẽ nói rõ: làm thêm `git pull` theo 11.2 (bước 2 và 5). Nên `git pull --ff-only` định kỳ kể cả khi dùng updater.
>
> **Sau mỗi lần `git pull` có đổi `docker-compose.yml`, chạy ngay `docker compose up -d --no-build`, rồi mới bấm Cập nhật trong web.** Updater dùng `docker-compose.yml` đang có trên đĩa: nếu file mới chưa được áp dụng, các container cũ và mới có thể nằm ở cấu hình mạng khác nhau.

### 11.2 Chạy tay
Dùng khi tắt updater, updater lỗi, hoặc bản mới đổi file cấu hình:
```bash
cd /opt/ads-mcp
# 1) sao lưu ngay
docker compose exec -T db pg_dump -U adsmcp -d adsmcp -Fc -Z zstd:6 > backups/pre-update-manual-$(date +%F_%H%M%S).dump
# 2) lấy file cấu hình mới (docker-compose.yml, Caddyfile, deploy/, script) - git hỏi Username + token (mục 5)
#    Cài bằng script (mục 0, thư mục ở tag cố định): bỏ bước này, làm bước 3 rồi chạy `sudo ads-mcp update-config`
#    (lấy cấu hình đúng tag APP_VERSION, kéo image, khởi động lại) thay cho bước 4-5.
git pull --ff-only
# 3) chọn phiên bản (KHÔNG có "v"; phải có trên trang Releases)
grep -q '^APP_VERSION=' .env && sed -i 's/^APP_VERSION=.*/APP_VERSION=1.1.0/' .env || echo 'APP_VERSION=1.1.0' >> .env
# 4) kéo image và khởi động lại (migrate tự chạy trước web/worker)
docker compose pull
docker compose up -d --no-build
# 5) Caddyfile/deploy/caddy thay đổi thì nạp lại Caddy (compose không tự phát hiện file mount thay đổi)
docker compose restart caddy
# 6) kiểm tra
docker compose ps
docker compose logs --tail=50 migrate web
```
- `git pull` báo *"Your local changes would be overwritten"*: xem `git status`/`git diff`. Thường do `deploy/caddy/client-ip-cloudflare.caddy` hoặc `deploy/nginx/cloudflare-realip.conf` được script sinh lại: `git checkout -- <file>` rồi `git pull --ff-only` và chạy lại script. Không sửa tay các file đã commit; tuỳ biến đặt trong `.env`.
- Phương án C: nếu `deploy/nginx/ads-mcp.conf` đổi, so sánh và áp dụng thay đổi vào `/etc/nginx/sites-available/ads-mcp.conf` (`diff`), rồi `sudo nginx -t && sudo systemctl reload nginx`.
- Phương án D: bước 4 tự kéo và tạo lại `cloudflared` khi bản mới đổi phiên bản image ghim trong `docker-compose.yml` (tunnel ngắt vài giây). Bước 5 (`restart caddy`) áp dụng như A/B.
- Biến mới trong `.env.example` luôn có giá trị mặc định an toàn trong `docker-compose.yml`, không cần chạy lại `gen-secrets.sh`. Riêng `APP_VERSION` là bắt buộc: kiểm tra `grep -c '^APP_VERSION=[0-9]' .env` ra `1`.
- Quay về bản cũ: đặt lại `APP_VERSION` cũ → `docker compose up -d --no-build`. Migration luôn tương thích ngược 1 phiên bản; chỉ khôi phục DB (mục 12.3) khi thật cần.

### 11.3 Tự kiểm tra chữ ký số của image (tuỳ chọn)
Updater đã tự làm việc này. Muốn kiểm tra tay (cần [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) bản 3 trở lên và đã `docker login ghcr.io` bằng token mục 5; thay `X.Y.Z` ở cả 2 chỗ):
```bash
cosign verify ghcr.io/schhung1822/nextgency-mcp-ads:X.Y.Z \
  --certificate-identity https://github.com/schhung1822/nextgency-mcp-ads/.github/workflows/docker.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
Image updater: thay `ads-mcp-simple:` bằng `ads-mcp-simple-updater:`. Kết quả đúng có dòng `The cosign claims were validated` và `The code-signing certificate was verified`.

### 11.4 Dọn image cũ
Mỗi phiên bản ~vài trăm MB. Sau khi bản mới chạy ổn vài ngày:
```bash
docker image ls 'ghcr.io/schhung1822/*'
docker image prune -a -f          # xoá image không còn container nào dùng (cần quay về bản cũ thì kéo lại)
docker system df
```

---

## 12. Sao lưu và khôi phục

### 12.1 Tự động
- Service `backup`: `pg_dump` nén zstd **ngay khi khởi động và mỗi 24 giờ**, lưu `./backups/adsmcp_YYYY-MM-DD_HHMMSS.dump`, giữ **14 ngày** (`BACKUP_KEEP_DAYS`, `BACKUP_INTERVAL_SECONDS` trong `.env`; áp dụng: `docker compose up -d --no-build backup`). Xem: `docker compose logs backup` (dòng `[backup] ok`).
- Updater tạo `backups/pre-update-*.dump` trước mỗi lần cập nhật; **không tự xoá**: dọn định kỳ, ví dụ giữ 5 file mới nhất: `ls -t backups/pre-update-* | tail -n +6 | xargs -r rm -f`.
- File dump **không chứa** `ENCRYPTION_KEYS` (chủ ý). Sao lưu `.env` riêng (mục 6.3).
- File dump **vẫn là dữ liệu bí mật**: chứa email người dùng, hash mật khẩu, token nền tảng đã mã hoá, nhật ký. Mã hoá trước khi đưa ra ngoài VPS (rclone `crypt`, restic, age...) và giữ khoá/mật khẩu mã hoá bản sao lưu **tách khỏi** `.env` lẫn nơi chứa dump.
- Bớt dung lượng (bỏ dữ liệu nhật ký khỏi bản sao lưu): `BACKUP_PG_DUMP_ARGS=--exclude-table-data=mcp_call_logs_p* --exclude-table-data=activity_logs_p*`.

Sao lưu ngay bằng tay:
```bash
docker compose exec backup sh -c 'pg_dump -Fc -Z zstd:6 -f /backups/adsmcp_manual_$(date +%F_%H%M%S).dump'
```

### 12.2 Đẩy bản sao lưu ra ngoài VPS (bắt buộc)
Hỏng VPS là mất cả database lẫn thư mục `backups`. Ví dụ rclone tới Google Drive/S3 với remote mã hoá `crypt` (cấu hình bằng `rclone config`), chạy hằng ngày bằng cron của user `deploy`:
```bash
sudo apt -y install rclone
rclone config                                    # tạo remote "gdrive" rồi remote "adsbackup" kiểu crypt bọc gdrive:ads-mcp
crontab -e
# thêm dòng (03:40 hằng ngày, chép file mới trong 2 ngày):
40 3 * * * rclone copy /opt/ads-mcp/backups adsbackup: --max-age 48h --log-file /home/deploy/rclone-ads.log
```
(Thư mục `backups/` do container `backup` ghi với quyền chỉ chủ sở hữu đọc; nếu `rclone` của `deploy` không đọc được, chạy cron bằng root: `sudo crontab -e`.) Hoặc dùng restic tới S3/Backblaze (xem `docs/van-hanh.md`). Diễn tập khôi phục mỗi quý: `docs/van-hanh.md#diễn-tập-khôi-phục`.

### 12.3 Khôi phục trên cùng máy chủ
```bash
cd /opt/ads-mcp
ls -lh backups/                                   # chọn file (adsmcp_*.dump hoặc pre-update-*.dump)
docker compose stop web worker updater            # bỏ "updater" nếu đã tắt cập nhật tự động
docker compose exec backup pg_restore --clean --if-exists -d adsmcp /backups/<tên-file>.dump
docker compose up -d --no-build
docker compose ps
```
Khôi phục file `pre-update-*` thì đặt lại `APP_VERSION` về bản tương ứng trước (`cp .env.bak .env` nếu `.env.bak` là bản ngay trước lần cập nhật đó).

### 12.4 Chuyển sang VPS mới
1. Làm mục 3, 4, 5, 6.1, 6.2 trên VPS mới.
2. Chép **file `.env` cũ** sang `/opt/ads-mcp/.env` (KHÔNG chạy `gen-secrets.sh`), sửa `HOST_PROJECT_DIR`/`UPDATER_DOCKER_CONFIG` nếu đường dẫn khác. Phương án B: chép cả `deploy/caddy/certs/`. Phương án D: `.env` đã chứa `TUNNEL_TOKEN`; **dừng cloudflared ở VPS cũ trước** (`docker compose stop cloudflared` hoặc tắt hẳn VPS cũ), nếu không cả 2 máy cùng nhận lưu lượng của tunnel.
3. Chép file dump vào `/opt/ads-mcp/backups/`.
4. ```bash
   docker compose pull
   docker compose up -d --no-build db backup
   docker compose exec backup pg_restore --clean --if-exists -d adsmcp /backups/<tên-file>.dump
   docker compose up -d --no-build
   ```
5. Trỏ DNS sang IP mới, đợi Caddy/Certbot cấp chứng chỉ. Phương án D: không đổi DNS (bản ghi CNAME trỏ vào tunnel, không trỏ IP), chỉ cần cloudflared ở VPS mới **Healthy**.

---

## 13. Giám sát và xử lý sự cố

### 13.1 Lệnh hay dùng và giám sát
```bash
cd /opt/ads-mcp
docker compose ps                                   # trạng thái, health
docker compose logs -f --tail=200 web worker        # ứng dụng
docker compose logs --tail=100 caddy                # HTTPS/proxy (key MCP đã che: /mcp/[redacted])
docker compose logs --tail=100 cloudflared          # phương án D: kết nối tunnel
docker compose logs --tail=100 updater              # cập nhật tự động
docker compose logs --tail=20 backup                # sao lưu
docker stats --no-stream                            # RAM/CPU
df -h / && docker system df                         # đĩa
```
- Giám sát từ ngoài (UptimeRobot, Better Stack...): `https://mcp.congty.vn/api/health` trả 200 mỗi 1-5 phút, kèm **cảnh báo hạn chứng chỉ** (Let's Encrypt và Cloudflare Origin CA đều không còn gửi email nhắc).
- Trong app: trang **Tổng quan** (token lỗi/sắp hết hạn, tỉ lệ lỗi MCP), **Cài đặt → Thông tin hệ thống** (dung lượng log, phiên bản API nền tảng sắp ngừng).
- Nhật ký container được Docker xoay vòng (tối đa 5 x 20 MB mỗi service). Nhật ký MCP/nhân sự trong DB giữ theo **Cài đặt → Lưu trữ nhật ký** (mặc định 3 tháng).

### 13.2 Lỗi khi kéo image từ GHCR
| Thông báo | Nguyên nhân | Cách xử lý |
|---|---|---|
| `denied`, `unauthorized`, `error from registry: denied` | Chưa `docker login`, token hết hạn/bị thu hồi, thiếu `read:packages`, tài khoản mất quyền Read trên repo, chưa authorize SSO | Tạo token mới (5.1) rồi `sudo ads-mcp token`, hoặc đăng nhập lại (6.2) |
| Lệnh tay chạy được nhưng updater báo lỗi bước "Tải image" | Đăng nhập bằng user khác với `UPDATER_DOCKER_CONFIG`, hoặc dùng credential helper | 6.2; sửa `UPDATER_DOCKER_CONFIG` rồi `docker compose up -d --no-build` |
| `manifest unknown`, `not found` | `APP_VERSION` sai (có chữ `v`, hoặc bản chưa phát hành/đang build) | Xem trang Releases; `APP_VERSION=1.0.0` |
| `no matching manifest for linux/...` | Kiến trúc máy không được build (vd đã chỉ build amd64) | Dùng VPS amd64 hoặc build lại cả arm64 (mục 14) |
| Updater: bước "Tải image" báo `không xác minh được chữ ký số` | Máy chủ không ra được Sigstore/ghcr.io, hoặc image không do GitHub Actions của Nextgency ký cho đúng tag | Mở chiều ra tới `ghcr.io`, `*.sigstore.dev`; xem `docker compose logs --tail=100 updater`; báo Nextgency nếu mạng ổn (11.1, 11.3) |
| Mọi lệnh `docker compose` báo `Thiếu APP_VERSION trong .env` | `.env` không có hoặc để trống `APP_VERSION` | Đặt `APP_VERSION=<phiên bản đang chạy>` (không có `v`) trong `.env` |
| `toomanyrequests` từ Docker Hub (postgres, caddy) | Giới hạn kéo ẩn danh của Docker Hub | Đợi, hoặc `docker login` Docker Hub |

### 13.3 Lỗi thường gặp khác
| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| 502 ngay sau khi khởi động | `web` chưa healthy (migrate đang chạy, app đang khởi động) | Đợi 1 phút; `docker compose ps`; `docker compose logs migrate web` |
| `migrate` exited (1), web không lên | Sai `DATABASE_URL`/`POSTGRES_PASSWORD`, migration lỗi | `docker compose logs migrate`; mật khẩu trong `DATABASE_URL` phải trùng `POSTGRES_PASSWORD` |
| Web báo lỗi cấu hình khi khởi động | `BETTER_AUTH_URL` không phải `https://`, thiếu secret | `docker compose logs web`, so với `.env.example` |
| Không cấp được chứng chỉ | DNS, cổng 80, giới hạn Let's Encrypt | 8 (lỗi thường gặp) |
| Cloudflare 521/522/524/525/526 | | 9.9 |
| Cloudflare Tunnel 1033/530/502, `ERR_TOO_MANY_REDIRECTS`, trang trắng | | 10b.10 |
| Trang Cập nhật: "Chưa bật" | updater không chạy/không ghi heartbeat | `docker compose ps updater`, `docker compose logs updater`; kiểm tra `COMPOSE_PROFILES=updater`, `HOST_PROJECT_DIR=/opt/ads-mcp` (đúng đường dẫn thật, `pwd`) rồi `docker compose up -d --no-build` |
| Trang Cập nhật: "Không tìm thấy bản phát hành nào" | Thiếu/sai/hết hạn `UPDATE_GITHUB_TOKEN` | `sudo ads-mcp token`; cài tay: 5.1, sửa `.env` → `docker compose up -d --no-build` |
| Cập nhật kết thúc `failed` ở bước quay về | Bản mới lỗi và quay về cũng lỗi | `.claude/docs/07-deployment.md` §6.6 (khôi phục từ `pre-update-*.dump`) |
| Mọi người bị khoá đăng nhập cùng lúc, nhật ký toàn một IP | Proxy cấu hình sai IP thật | Phương án B: `CADDY_CLIENT_IP=cloudflare`; C: file Nginx của dự án + realip; D: `CADDY_CLIENT_IP=tunnel` |
| AI báo 404 khi gọi MCP | Link sai, MCP tắt/hết hạn/đã xoay key, hoặc Host khác `APP_DOMAIN` | Sao chép lại link trong trang MCP |

### 13.4 Quên mật khẩu / mất 2FA của admin
```bash
cd /opt/ads-mcp
docker compose run --rm web node dist/cli.mjs reset-password admin@congty.vn   # in mật khẩu tạm 1 lần
docker compose run --rm web node dist/cli.mjs reset-2fa admin@congty.vn
docker compose run --rm web node dist/cli.mjs unlock admin@congty.vn           # gỡ khoá do nhập sai nhiều lần
docker compose run --rm web node dist/cli.mjs unban admin@congty.vn            # mở khoá tài khoản bị khoá
docker compose run --rm web node dist/cli.mjs create-admin --email ban@congty.vn
docker compose run --rm web node dist/cli.mjs help
```
Không đặt mật khẩu trên dòng lệnh (lộ qua lịch sử shell); CLI tự sinh mật khẩu tạm hoặc đọc từ biến `ADMIN_PASSWORD`/stdin. `ADMIN_PASSWORD` ghi trong `.env` **không** tới được CLI (compose chỉ truyền các biến trong danh sách, mục 6.3): truyền từ shell bằng `read -rsp "Mật khẩu tạm: " ADMIN_PASSWORD; export ADMIN_PASSWORD` rồi `docker compose run --rm -e ADMIN_PASSWORD web node dist/cli.mjs create-admin --email ban@congty.vn` (`-e TÊN` không kèm giá trị: lấy từ shell, không lộ trên dòng lệnh), xong `unset ADMIN_PASSWORD`.

---

## 14. Giới hạn GHCR (gói Free)

Theo docs.github.com ("GitHub Packages billing", truy cập 2026-10-03):
- **Container registry (ghcr.io) hiện miễn phí** cả dung lượng lưu trữ lẫn băng thông: *"Container image storage and bandwidth for the Container registry is currently free. If you use Container registry, you'll be informed at least one month in advance of any change to this policy."*
- Hạn mức gói Free (tổ chức và cá nhân) cho **các loại package khác** (npm, Maven...): **500 MB lưu trữ, 1 GB truyền dữ liệu/tháng** (Team: 2 GB / 10 GB). Hạn mức này hiện **không** áp cho image container. Không có phương thức thanh toán thì vượt hạn mức sẽ bị chặn (không bị tính tiền).
- Tải package từ GitHub Actions không tính vào băng thông.

Khuyến nghị (phòng khi GitHub bắt đầu tính phí, sẽ báo trước ít nhất 1 tháng):
- **Dọn phiên bản cũ**: repo → Packages → `ads-mcp-simple` / `ads-mcp-simple-updater` → Package settings / versions → xoá các tag cũ (giữ vài bản gần nhất để quay về). Image multi-arch tạo thêm các phiên bản **không có tag** (manifest con amd64/arm64): **không xoá** các bản không tag của image đang dùng, nếu không tag đó hỏng (`manifest unknown`). Action `actions/delete-package-versions` với `delete-only-untagged-versions` **không an toàn** cho image multi-arch.
- **Chỉ build amd64** nếu không có VPS arm64: trong `.github/workflows/docker.yml`, ở cả 2 bước `docker/build-push-action`, đổi `platforms: linux/amd64,linux/arm64` thành `platforms: linux/amd64` (có thể bỏ bước `docker/setup-qemu-action`). Giảm một nửa dung lượng và thời gian build; VPS arm64 khi đó sẽ báo `no matching manifest`.
- Nhánh `main` cũng đẩy tag `:main` và `:sha-xxxxxxx` mỗi lần push: dọn định kỳ.

---

## 15. Phụ lục

### 15.1 Checklist bảo mật sau cài đặt
- [ ] SSH chỉ dùng key, tắt đăng nhập mật khẩu và root (3.3); fail2ban (tuỳ chọn).
- [ ] UFW bật, chỉ 22/80/443 (phương án D: chỉ 22); tường lửa của nhà cung cấp cũng vậy. `ss -tlnp` không có `5432` mở ra ngoài; web chỉ ở `127.0.0.1`.
- [ ] Không thêm `ports:` cho `db`; không đổi web publish ra `0.0.0.0`.
- [ ] `.env` quyền 600, đã sao lưu ở nơi an toàn **khác** nơi chứa bản dump.
- [ ] Bản sao lưu được đẩy ra ngoài VPS (12.2) và đã thử khôi phục.
- [ ] Admin bật 2FA, bật "Bắt buộc 2FA cho quản trị viên".
- [ ] Token GitHub (PAT classic) chỉ tích `repo` + `read:packages` (bản cài cũ: Token A chỉ `read:packages`, Token B chỉ `repo`), của tài khoản chỉ có quyền Read trên repo Nextgency (nên là tài khoản riêng cho máy chủ); có hạn và lịch nhắc; không còn `~/.git-credentials` / `credential.helper store` trên VPS (5.4); deploy key (nếu dùng) chỉ đọc.
- [ ] Bản sao lưu được mã hoá trước khi ra khỏi VPS; khoá mã hoá bản sao lưu cất riêng (12.1).
- [ ] Không dùng credential helper cho `docker login`; `UPDATER_DOCKER_CONFIG` đúng user.
- [ ] Kiểm tra IP thật: nhật ký nhân sự ghi đúng IP của bạn (9.4).
- [ ] Phương án B: Full (strict), Bot Fight Mode tắt, WAF skip `/mcp/`, AOP bật (9.5).
- [ ] Phương án C: `X-Forwarded-For $remote_addr` (không phải `$proxy_add_x_forwarded_for`), `certbot renew --dry-run` đạt.
- [ ] Phương án D: UFW và tường lửa nhà cung cấp chỉ mở SSH; `docker compose port caddy 80` là `127.0.0.1:...`; `CADDY_CLIENT_IP=tunnel`; route chỉ trỏ `http://caddy:80`, không đặt HTTP Host Header; Bot Fight Mode tắt, WAF skip `/mcp/`; nếu dùng Access thì đã Bypass `/mcp/*` + `/.well-known/*`; `TUNNEL_TOKEN` chỉ nằm trong `.env` (quyền 600); không bật log debug của cloudflared.
- [ ] Access log không chứa key MCP: `docker compose logs caddy | grep -c 'amcp_'` (hoặc `sudo grep -c amcp_ /var/log/nginx/ads-mcp.access.log`) bằng 0.
- [ ] Đăng ký giám sát `/api/health` + hạn chứng chỉ.
- [ ] Nắm rủi ro service `updater` (có `docker.sock` = quyền root máy chủ; `.claude/docs/07-deployment.md` §6.4). Không muốn: bỏ `COMPOSE_PROFILES=updater` → `docker compose rm -sf updater`, cập nhật tay (11.2).

### 15.2 Checklist phát hành phiên bản mới (người duy trì, Nextgency)
Quy tắc dự án: **build Docker image ở máy local thành công và chạy thử trước, rồi mới push**.
1. `pnpm lint && pnpm typecheck && pnpm test` xanh; migration mới tương thích ngược 1 phiên bản (07-deployment §6.7).
2. Sửa `package.json#version` = `X.Y.Z`, commit `chore(release): vX.Y.Z`.
3. Build local đúng target phát hành **chỉ để chạy thử** (image này không có chữ ký, **không bao giờ** `docker push` image/tag phát hành bằng tay: updater của khách sẽ từ chối):
   ```bash
   docker build --build-arg APP_BUILD_VERSION=X.Y.Z -t ghcr.io/schhung1822/nextgency-mcp-ads:X.Y.Z .
   docker build --target updater --build-arg APP_BUILD_VERSION=X.Y.Z -t ghcr.io/schhung1822/nextgency-mcp-ads-updater:X.Y.Z .
   ```
   (hoặc `APP_BUILD_VERSION=X.Y.Z APP_VERSION=X.Y.Z docker compose -f docker-compose.yml -f docker-compose.build.yml build`)
4. Smoke test stack production local với chính image đó: `APP_VERSION=X.Y.Z docker compose up -d --no-build`, `migrate` exit 0, `web` healthy, đăng nhập, gọi thử 1 tool MCP.
5. Ghi chú phát hành: nêu rõ nếu đổi `docker-compose.yml`, `Caddyfile`, `deploy/`, `.env.example` (người vận hành phải làm 11.2).
5b. **Thử ký + xác minh bằng tag rc trước** (bắt buộc khi workflow ký/updater thay đổi, nên làm mỗi lần): đặt `package.json#version` = `X.Y.Z-rc.1`, commit lên `main`, `git tag vX.Y.Z-rc.1 && git push origin main vX.Y.Z-rc.1`. CI build + ký 2 image `X.Y.Z-rc.1` (không tạo Release). Rồi xác minh bằng cosign **trong image updater vừa build** (đúng bản cosign khách sẽ chạy):
   ```bash
   # digest index (multi-arch) của 2 image rc, rồi xác minh bằng chính cosign trong image updater rc
   W=$(docker buildx imagetools inspect ghcr.io/schhung1822/nextgency-mcp-ads:X.Y.Z-rc.1 --format '{{.Manifest.Digest}}')
   U=$(docker buildx imagetools inspect ghcr.io/schhung1822/nextgency-mcp-ads-updater:X.Y.Z-rc.1 --format '{{.Manifest.Digest}}')
   for ref in "ghcr.io/schhung1822/nextgency-mcp-ads@$W" "ghcr.io/schhung1822/nextgency-mcp-ads-updater@$U"; do
     docker run --rm -v "$HOME/.docker:/root/.docker:ro" -e TUF_ROOT=/tmp/sigstore-tuf --entrypoint cosign \
       ghcr.io/schhung1822/nextgency-mcp-ads-updater:X.Y.Z-rc.1 verify \
       --certificate-identity https://github.com/schhung1822/nextgency-mcp-ads/.github/workflows/docker.yml@refs/tags/vX.Y.Z-rc.1 \
       --certificate-oidc-issuer https://token.actions.githubusercontent.com "$ref" || echo "KHÔNG ĐẠT: $ref"
   done
   ```
   Cả 2 phải đạt (`The cosign claims were validated`). Máy dùng Docker Desktop (`credsStore` trong `~/.docker/config.json`): container không đọc được credential helper, hãy đăng nhập vào thư mục riêng `docker --config "$PWD/cfg-tmp" login ghcr.io -u <user> --password-stdin` rồi mount `cfg-tmp` thay cho `$HOME/.docker` (xoá thư mục sau khi xong).
   Tag rc không bao giờ tới tay khách: job `release` chỉ chạy với `vX.Y.Z` (rc không có GitHub Release), kiểm tra bản mới của web chỉ nhận Release/tag dạng `vX.Y.Z` (bỏ qua prerelease), updater từ chối phiên bản đích không phải `x.y.z`, và rc không được gắn `latest`/`X.Y`.
   Đạt thì sửa `package.json#version` về `X.Y.Z`, commit, rồi mới tạo tag thật. Không đạt: **không** phát hành, sửa workflow rồi thử `-rc.2`.
6. `git push origin main`, rồi `git tag vX.Y.Z && git push origin vX.Y.Z` (tag phải trỏ vào commit đã có trên `main`). Bản phát hành **chỉ** được tạo bởi CI.
7. GitHub Actions `docker.yml`: kiểm tra version khớp tag, tag nằm trên `main`, bản chưa từng phát hành → build + push 2 image (amd64 + arm64, kèm SBOM/provenance) → ký cả 2 bằng cosign keyless → tạo GitHub Release. Theo dõi tab Actions đến khi xanh. Lỗi giữa chừng thì chạy lại job (Release chỉ được tạo ở cuối); đã có Release thì **không** đẩy lại cùng phiên bản, tạo bản vá mới.
7b. Bản phát hành có sửa `scripts/install-ads-mcp.sh` hoặc `scripts/ads-mcp`: hai file này nằm ngay trong repo (không còn repo installer riêng), nên không cần chép đi đâu; chỉ cần cập nhật README nếu câu hỏi / tuỳ chọn của script đổi.
8. Chạy lệnh `cosign verify` ở 11.3 cho **cả 2 image** `X.Y.Z`. Kiểm tra Release và package trên GHCR có tag `X.Y.Z`; trên một máy thử, admin bấm **Cập nhật** và xác nhận thành công trước khi thông báo cho khách.

### 15.3 Nguồn tham khảo (truy cập 2026-10-03)
- Docker: <https://docs.docker.com/engine/install/ubuntu/>, <https://docs.docker.com/engine/install/debian/>, <https://docs.docker.com/engine/install/linux-postinstall/>, <https://docs.docker.com/engine/network/packet-filtering-firewalls/>, <https://docs.docker.com/engine/network/firewall-iptables/>, <https://docs.docker.com/engine/network/port-publishing/>, <https://docs.docker.com/reference/compose-file/build/>, <https://docs.docker.com/reference/compose-file/services/#pull_policy>, <https://docs.docker.com/reference/cli/docker/login/>, <https://docs.docker.com/engine/release-notes/28/> (sửa lỗi cổng loopback từ 28.0.0).
- Caddy: <https://caddyserver.com/docs/caddyfile/options> (trusted_proxies, client_ip_headers), <https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults>, <https://caddyserver.com/docs/caddyfile/directives/import>, <https://caddyserver.com/docs/caddyfile/directives/tls>, <https://caddyserver.com/docs/automatic-https>.
- Cloudflare: <https://www.cloudflare.com/ips-v4>, <https://www.cloudflare.com/ips-v6>, <https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/>, <https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full/>, <https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/>, <https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/>, <https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/>, <https://developers.cloudflare.com/fundamentals/reference/connection-limits/>, <https://developers.cloudflare.com/fundamentals/reference/http-headers/>, <https://developers.cloudflare.com/cache/concepts/default-cache-behavior/>, <https://developers.cloudflare.com/waf/custom-rules/skip/>, <https://developers.cloudflare.com/bots/get-started/bot-fight-mode/>, <https://developers.cloudflare.com/rules/configuration-rules/settings/>.
- Cloudflare Tunnel (phương án D): <https://developers.cloudflare.com/tunnel/get-started/>, <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/>, <https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/>, <https://developers.cloudflare.com/tunnel/reference/run-parameters/>, <https://developers.cloudflare.com/tunnel/concepts/routing/>, <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/>, <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/>, <https://developers.cloudflare.com/tunnel/troubleshooting/https-origins/>, <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/>, <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/>, <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/>, <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/>, <https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/>, <https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-530/>, <https://developers.cloudflare.com/rules/configuration-rules/response-body-inspection/>, <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/>, <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/>, <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/>, <https://github.com/cloudflare/cloudflared/releases> (2026.9.3, 2026-09-24), <https://github.com/cloudflare/cloudflared/blob/master/RELEASE_NOTES> (`tunnel ready` từ 2024.11.1, `--token-file` từ 2025.4.0), <https://github.com/cloudflare/cloudflared/blob/master/Dockerfile>, <https://github.com/cloudflare/cloudflared/blob/master/ingress/origin_proxy.go> (giữ Host), <https://github.com/cloudflare/cloudflared/blob/master/proxy/proxy.go> (không sửa X-Forwarded-For), <https://hub.docker.com/r/cloudflare/cloudflared>.
- Nginx/Certbot/Let's Encrypt: <https://nginx.org/en/docs/http/ngx_http_proxy_module.html>, <https://nginx.org/en/docs/http/ngx_http_realip_module.html>, <https://nginx.org/en/docs/http/ngx_http_map_module.html>, <https://nginx.org/en/docs/http/ngx_http_log_module.html>, <https://certbot.eff.org/instructions?ws=nginx&os=snap>, <https://eff-certbot.readthedocs.io/en/stable/using.html>, <https://letsencrypt.org/docs/rate-limits/>, <https://letsencrypt.org/2025/06/26/expiration-notification-service-has-ended>, <https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life>, <https://letsencrypt.org/2025/12/02/from-90-to-45>.
- GitHub: <https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry>, <https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility>, <https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens>, <https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization>, <https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys>, <https://docs.github.com/en/billing/concepts/product-billing/github-packages>, <https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package>.

### 15.4 Đã kiểm chứng / chưa kiểm chứng (bản 1.0.0)
- **Đã kiểm chứng trên máy dev (Docker 29.6, Compose 5.3):** `docker compose config` hợp lệ cho cả 3 phương án A/B/C (kể cả lệnh kiểu updater `-f docker-compose.yml`); `deploy.replicas: 0` gỡ đúng container Caddy; web publish chỉ ở `127.0.0.1`; Compose khi file có `build:` sẽ tự build lúc kéo image bị từ chối (lý do bỏ `build:` khỏi file chính); `caddy validate` cho 4 tổ hợp `CADDY_CLIENT_IP`/`CADDY_TLS`; Caddy thật: ghi đè `X-Forwarded-For` (direct và sau proxy tin cậy) + che key trong log; `nginx -t` trên Nginx 1.24 (Ubuntu 24.04) và 1.30; Nginx thật: ghi đè `X-Forwarded-For`, header bảo mật, che key trong access log; `gen-env.mjs` và `gen-secrets.sh` (busybox) cho 3 giá trị `--ssl`; script dải IP Cloudflare.
- **Phương án D (đã kiểm chứng trên máy dev, 2026-10-03):** `docker compose config` hợp lệ cho cả 4 phương án, với `.env` kiểu cũ (không có biến mới) và `.env` sinh mới; A/B/C chỉ khác trước ở service `cloudflared` (`replicas: 0`) và biến rỗng `CADDY_SITE_SCHEME` của caddy (cổng không đổi; caddy được tạo lại 1 lần khi `up` sau `git pull`); lệnh kiểu updater (`-f docker-compose.yml up -d --no-deps web worker`, chạy thử `--dry-run`) không đụng `caddy`/`cloudflared`; `caddy validate` đạt cho A, B, B-aop, B 9.8 và D, kết quả `caddy adapt` của A/B giống hệt từng byte với Caddyfile trước khi sửa; Caddy thật ở chế độ tunnel: chỉ nghe `:80`, không xin chứng chỉ, `CF-Connecting-IP` (IPv4/IPv6) ghi đè `X-Forwarded-For` giả, `X-Forwarded-Proto: https` được giữ, `X-Forwarded-Proto: http` → 308 sang HTTPS, kết nối từ dải ngoài mạng riêng không được tin `CF-Connecting-IP`, key MCP bị che trong log; `cloudflare/cloudflared:2026.9.3` chạy với `read_only` + `cap_drop: ALL` + `no-new-privileges` và token giả: kiểm tra mạng lúc khởi động đạt, tới bước đăng ký thì bị từ chối (`Failed to get tunnel`), healthcheck `cloudflared tunnel ready` trả mã 1 khi chưa có kết nối, token không xuất hiện trong log; `gen-env.mjs` và `gen-secrets.sh` (busybox) cho kết quả giống nhau với `--ssl tunnel`.
- **Script cài nhanh `scripts/install-ads-mcp.sh` + lệnh `ads-mcp` (2026-10-09, bản 1.0.6):** chạy thật trong container Docker-in-Docker đặc quyền `ubuntu:24.04` và `debian:12` (không systemd: script tự chạy `dockerd` nền), chế độ kiểm thử `ADS_MCP_INSTALL_TEST=1` (chỉ bỏ so khớp DNS, cho tên miền `*.localhost`, kiểm tra HTTPS bằng `curl -k` vào chứng chỉ nội bộ của Caddy). Đạt: cài mới đầy đủ (apt, Docker từ kho chính thức, kiểm tra token với GitHub thật, `git clone` tag v1.0.6, `docker login` + kéo image riêng tư từ GHCR, `.env`, migrate, web healthy, HTTPS, updater chạy), UFW bật được trong container Debian, phương án Cloudflare Tunnel với token giả (caddy → web OK, cloudflared báo chưa kết nối), chạy lại = sửa chữa (hash `POSTGRES_PASSWORD`/`ENCRYPTION_KEYS`/`MCP_KEY_PEPPER`/`BETTER_AUTH_SECRET` không đổi), sửa chữa sau khi Docker bị tắt, đổi phiên bản `--version` 1.0.6 → 1.0.5 rồi `ads-mcp update-config` về 1.0.6 (nạp lại Caddy), mọi lệnh `ads-mcp`, các đường lỗi (401, token của tài khoản khác, tên miền/email sai, thiếu thông tin khi không có bàn phím, token tunnel sai, DNS trỏ Cloudflare/sai IP, cổng 80 bận, bản phát hành không tồn tại, hệ điều hành không hỗ trợ, không phải root), luồng hỏi đáp qua pty; token không xuất hiện trong nhật ký, `.git/config`, `/etc/ads-mcp.conf` hay log cloudflared. **Chưa kiểm chứng:** VPS thật với systemd, chứng chỉ Let's Encrypt thật, Cloudflare Tunnel thật, tạo swap (container không cho), UFW trên máy thật (luật trong container chỉ áp cho netns của container), token có ngày hết hạn và token thiếu scope / fine-grained với GitHub thật (logic đọc header đã có unit test), chấp nhận lời mời repo.
- **Chưa kiểm chứng (không có VPS/Cloudflare/GHCR thật):** cài đặt trọn vẹn trên VPS Ubuntu/Debian thật; kéo image riêng tư từ GHCR (cả bằng updater); Cloudflare thật (Origin CA, AOP, cache/WAF/bot rule, 524, biến thể 9.8); **Cloudflare Tunnel với tunnel và token thật** (route Published application, chuyển hướng, giới hạn 125 giây qua tunnel, SSE qua tunnel, Cloudflare Access với AI client thật, tên menu dashboard); Certbot thật; luật `DOCKER-USER` (9.6).
