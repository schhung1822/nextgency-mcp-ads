# Vận hành Ads MCP

> Dành cho người quản trị máy chủ của đơn vị được noti.vn cấp quyền. Mọi lệnh chạy trong thư mục cài đặt (vd `/opt/ads-mcp`). Cài đặt mới, 4 phương án đưa ra Internet (Caddy / Cloudflare / Nginx / Cloudflare Tunnel), quyền GitHub/GHCR: xem [deploy-vps.md](deploy-vps.md).

## Các thành phần
| Service | Vai trò | Ghi chú |
|---|---|---|
| `db` | PostgreSQL 18 | Volume `pgdata`, không mở cổng ra ngoài |
| `migrate` | Chạy migration rồi thoát | Chạy lại mỗi lần `up`; có khoá chống chạy trùng |
| `web` | Giao diện quản trị + endpoint `/mcp/<key>` | `node server.js`, healthcheck `/api/health` |
| `worker` | Job nền (pg-boss) | Kiểm tra token, đồng bộ TKQC, dọn log, tổng hợp thống kê |
| `caddy` | HTTPS + reverse proxy | Cert Let's Encrypt lưu ở volume `caddy_data`; tắt (`CADDY_REPLICAS=0`) khi dùng Nginx trên máy chủ |
| `backup` | `pg_dump` định kỳ | File ở `./backups` |
| `updater` | Cập nhật tự động khi admin bấm nút (tuỳ chọn, profile `updater`) | Service duy nhất có `docker.sock`; không mở cổng |

Lệnh hay dùng:
```bash
docker compose ps                         # trạng thái, health
docker compose logs -f --tail=200 web worker
docker compose restart web worker
docker compose run --rm web node dist/cli.mjs <lệnh>   # CLI quản trị
```
CLI: `create-admin --email <email>` (mật khẩu tạm: biến `ADMIN_PASSWORD` hoặc `--password-stdin`, không có thì tự sinh) · `reset-password <email>` · `reset-2fa <email>` · `unlock <email>` (gỡ khoá đăng nhập do nhập sai nhiều lần) · `unban <email>` (mở khoá tài khoản bị khoá) · `google:refresh-token --client-id …` (lấy refresh token Google Ads) · `reencrypt`.

Không đặt mật khẩu/secret trên dòng lệnh (lộ qua `ps`, lịch sử shell).
`docker-compose.yml` chỉ truyền vào container các biến có trong danh sách của nó, nên `ADMIN_PASSWORD` ghi trong `.env` **không** tới được CLI. Muốn tự đặt mật khẩu tạm, truyền qua biến của shell (không ghi giá trị trên dòng lệnh) hoặc stdin:
```bash
read -rsp "Mật khẩu tạm: " ADMIN_PASSWORD; echo; export ADMIN_PASSWORD
docker compose run --rm -e ADMIN_PASSWORD web node dist/cli.mjs create-admin --email ban@congty.vn; unset ADMIN_PASSWORD
```
(hoặc `--password-stdin` kèm `docker compose run --rm -T web ...`; không đặt gì thì CLI tự sinh mật khẩu tạm và in ra 1 lần).

Lấy refresh token Google Ads (chỉ khi dùng OAuth; khuyên dùng service account để khỏi cần bước này) qua đường hầm SSH, cổng chỉ publish ra loopback của VPS:
```bash
ssh -L 8085:127.0.0.1:8085 user@vps          # trên máy của bạn, giữ cửa sổ này mở
docker compose run --rm -p 127.0.0.1:8085:8085 web \
  node dist/cli.mjs google:refresh-token --client-id <CLIENT_ID> --host 0.0.0.0   # client secret nhập ẩn khi được hỏi
```
Mở link CLI in ra bằng trình duyệt trên máy của bạn, đăng nhập Google (tài khoản bị Google Ads bắt buộc passkey phải dùng passkey) → **Cho phép**. OAuth consent screen phải ở **In production** (kèm Verify Branding) — để **Testing** thì refresh token hết hạn sau 7 ngày. Không cần developer token.

Trang công khai cho app Meta/TikTok/Google/OpenAI (không cần đăng nhập): `https://<tên miền>/privacy`, `/terms`, `/data-deletion` - điền **Cài đặt → Thông tin pháp lý** (tên đơn vị vận hành, email liên hệ) trước khi dán vào Meta App Dashboard; sao chép nhanh ở khối "Liên kết cho ứng dụng" dưới sidebar.

## Cập nhật phiên bản
### Tự động (admin bấm nút trong web)
Service `updater` (bật bằng `COMPOSE_PROFILES=updater` + `HOST_PROJECT_DIR` trong `.env`; cài mới có sẵn). Một lần cập nhật: sao lưu `backups/pre-update-<thời gian>.dump` (giữ lại) → tải image `ghcr.io/notivn/ads-mcp-simple:<bản mới>` và xác minh chữ ký số (cosign, do GitHub Actions của noti.vn ký cho đúng tag; cần ra Internet tới Sigstore) → chạy migration bằng image mới → ghi `APP_VERSION` vào `.env` (bản gốc ở `.env.bak`) → thay `web`/`worker` → kiểm tra sức khoẻ; lỗi thì tự quay về bản cũ. Web gián đoạn khoảng 1-2 phút. Theo dõi: trang Cập nhật trong web, hoặc `docker compose logs -f updater`.
- Updater báo "chưa bật": `docker compose ps updater`, `docker compose logs updater` (thường do `HOST_PROJECT_DIR` sai hoặc chưa `up -d` sau khi thêm `COMPOSE_PROFILES=updater`).
- Image riêng tư: trên VPS `docker login ghcr.io` bằng **token GitHub** (1 PAT classic tích `repo` + `read:packages`; đăng nhập bằng user chạy compose; nếu không phải root đặt `UPDATER_DOCKER_CONFIG=/home/<user>/.docker`; không dùng credential helper). Repo riêng tư: đặt `UPDATE_GITHUB_TOKEN` = **cùng token đó** để web thấy bản mới; token cũng là mật khẩu khi `git pull` hỏi (không lưu bằng `credential.helper store`). Cài bằng script: `sudo ads-mcp token` đổi token ở mọi nơi. Bản cài cũ dùng 2 token (Token A `read:packages`, Token B `repo`) vẫn chạy bình thường. Chi tiết: [deploy-vps.md §5-6](deploy-vps.md#5-quyền-truy-cập-github-mã-nguồn--image-riêng-tư).
- Updater chỉ đổi image, **không** cập nhật `docker-compose.yml`/`Caddyfile`/`deploy/`: khi ghi chú phát hành báo các file này đổi, làm thêm `git pull` theo mục dưới, và chạy `docker compose up -d --no-build` **trước** lần bấm Cập nhật tiếp theo.
- Nếu cập nhật tự động báo `failed` ở bước quay về bản cũ: làm theo mục "Khôi phục từ file pre-update" trong `.claude/docs/07-deployment.md` §6.6 (dữ liệu trước cập nhật nằm ở `backups/pre-update-*.dump`). Dọn các file `pre-update-*` cũ bằng tay (updater không tự xoá).
- Cập nhật tay khi tắt updater: §6.8 cùng tài liệu.

### Thủ công (image dựng sẵn)
VPS **không build** từ mã nguồn (`docker-compose.yml` không có `build:`).
```bash
# 1) sao lưu ngay trước khi cập nhật
docker compose exec backup sh -c 'pg_dump -Fc -Z zstd:6 -f /backups/adsmcp_pre-update_$(date +%F_%H%M%S).dump'
# 2) lấy file cấu hình mới (git hỏi Username + token GitHub; cài bằng script: đổi APP_VERSION rồi `sudo ads-mcp update-config`) + chọn phiên bản (không có "v", bắt buộc)
git pull --ff-only
sed -i 's/^APP_VERSION=.*/APP_VERSION=1.2.3/' .env
# 3) kéo image và khởi động lại
docker compose pull
docker compose up -d --no-build
docker compose restart caddy        # nếu Caddyfile hoặc deploy/caddy thay đổi
# 4) kiểm tra
docker compose ps
docker compose logs --tail=50 migrate web
```
- `migrate` phải ở trạng thái `exited (0)`; `web` ở `healthy`. Nếu migrate lỗi, `web`/`worker` **không** khởi động bản mới - đọc log, sửa, chạy lại `docker compose up -d --no-build`.
- `docker compose pull` báo `denied`/`unauthorized`: đăng nhập lại `docker login ghcr.io` (PAT hết hạn). Chi tiết: [deploy-vps.md §11](deploy-vps.md#11-cập-nhật-phiên-bản).
- Dọn image cũ định kỳ: `docker image prune -a -f` (sau khi bản mới chạy ổn).
- Theo dõi bản vá bảo mật của Next.js, Better Auth, PostgreSQL (bản minor `18.x`), Caddy — cập nhật Ads MCP thường xuyên.

## Sao lưu
**Tự động**: service `backup` chạy ngay khi khởi động rồi mỗi `BACKUP_INTERVAL_SECONDS` (mặc định 86400 = 24 giờ), giữ `BACKUP_KEEP_DAYS` ngày (mặc định 14). Biến đặt trong `.env`:
```ini
BACKUP_KEEP_DAYS=14
BACKUP_INTERVAL_SECONDS=86400
# Bỏ dữ liệu nhật ký khỏi bản sao lưu (file nhỏ hơn nhiều; vẫn giữ cấu trúc bảng):
# BACKUP_PG_DUMP_ARGS=--exclude-table-data=mcp_call_logs_p* --exclude-table-data=activity_logs_p*
```
Áp dụng thay đổi: `docker compose up -d backup`. Xem kết quả: `docker compose logs backup` (dòng `[backup] ok …`).

**Đẩy ra ngoài VPS** (bắt buộc — hỏng VPS là mất cả DB lẫn backup):
```bash
# ví dụ restic tới S3/Backblaze (mã hoá phía client), chạy bằng cron hằng ngày
restic -r s3:s3.amazonaws.com/congty-ads-mcp-backup backup ./backups
restic -r s3:s3.amazonaws.com/congty-ads-mcp-backup forget --keep-daily 14 --keep-monthly 6 --prune
```
(Có thể dùng `rclone copy ./backups remote:ads-mcp --max-age 48h` tới Google Drive/OneDrive với remote mã hoá `crypt`.)

File dump là **dữ liệu bí mật** (email người dùng, hash mật khẩu, token nền tảng đã mã hoá, nhật ký): chỉ đưa ra ngoài VPS khi đã mã hoá phía máy chủ (restic, rclone `crypt`, hoặc `age`), và cất mật khẩu/khoá mã hoá bản sao lưu **riêng**, không để chung với `.env` hay với nơi chứa dump.

**Sao lưu bí mật riêng**: lưu bản sao `.env` (tối thiểu `ENCRYPTION_KEYS`, `MCP_KEY_PEPPER`, `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`) trong trình quản lý mật khẩu của công ty, **khác nơi** chứa file dump.
- Mất `ENCRYPTION_KEYS` → mọi token nền tảng trong DB không giải mã được (phải dán lại toàn bộ).
- Mất `MCP_KEY_PEPPER` → mọi link MCP ngừng hoạt động (phải xoay key từng MCP).
- Mất `BETTER_AUTH_SECRET` → mọi phiên đăng nhập và 2FA phải thiết lập lại.

## Khôi phục
```bash
ls -lh backups/                                   # chọn file
docker compose stop web worker
docker compose exec backup pg_restore --clean --if-exists -d adsmcp /backups/<file>.dump
docker compose up -d
```
`--clean --if-exists` xoá đối tượng hiện có trước khi tạo lại. Sau khi khôi phục, `migrate` chạy lại khi `up` (không làm gì nếu schema đã mới nhất).

**Sang VPS mới**: cài Docker → `git clone` → `docker login ghcr.io` → **chép file `.env` cũ** (không chạy gen-env) → chép file dump vào `./backups/` → `docker compose pull && docker compose up -d --no-build db backup` → lệnh `pg_restore` ở trên → `docker compose up -d --no-build` → trỏ DNS sang IP mới ([deploy-vps.md §12.4](deploy-vps.md#124-chuyển-sang-vps-mới)).

## Diễn tập khôi phục
Làm **mỗi quý** (và sau mỗi lần đổi cấu hình backup) — backup chưa thử khôi phục coi như chưa có:
```bash
# DB tạm, không ảnh hưởng hệ thống đang chạy
docker run -d --name restore-test -e POSTGRES_PASSWORD=test -e POSTGRES_USER=adsmcp -e POSTGRES_DB=adsmcp postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
sleep 5
docker cp backups/<file>.dump restore-test:/tmp/x.dump
docker exec restore-test pg_restore -U adsmcp -d adsmcp --no-owner /tmp/x.dump
docker exec restore-test psql -U adsmcp -d adsmcp -c "select count(*) from \"user\";" -c "select count(*) from connections;"
docker rm -f restore-test
```
Đạt khi: lệnh không lỗi, số người dùng/kết nối khớp hệ thống thật. Ghi lại ngày diễn tập và thời gian khôi phục.

## Xoay khoá mã hoá (`ENCRYPTION_KEYS`)
Khi nghi lộ khoá, khi nhân sự giữ khoá nghỉ việc, hoặc định kỳ hằng năm. `ENCRYPTION_KEYS` là danh sách `phiên_bản:khoá` cách nhau bởi dấu phẩy; **khoá đầu tiên** dùng để mã hoá dữ liệu mới, các khoá sau chỉ dùng để giải mã dữ liệu cũ.
1. Sao lưu DB + `.env` hiện tại.
2. Sinh khoá mới: `openssl rand -base64 32`.
3. Sửa `.env`, thêm khoá mới **lên đầu**, giữ khoá cũ:
   ```ini
   ENCRYPTION_KEYS=2:<khoá_mới>,1:<khoá_cũ>
   ```
4. `docker compose up -d` (web, worker nạp khoá mới).
5. Mã hoá lại toàn bộ dữ liệu bằng khoá mới:
   ```bash
   docker compose run --rm web node dist/cli.mjs reencrypt
   ```
   (khi dev: `pnpm cli reencrypt`). Đợi lệnh báo hoàn tất, không còn bản ghi dùng khoá `1`.
6. Bỏ khoá cũ khỏi `.env` (`ENCRYPTION_KEYS=2:<khoá_mới>`) → `docker compose up -d`.
7. Cập nhật bản sao lưu `.env` ở nơi an toàn. Backup DB **cũ** vẫn cần khoá cũ để đọc — giữ khoá cũ (ngoại tuyến) đến khi các backup đó hết hạn.

`MCP_KEY_PEPPER` **không** xoay theo cách này — đổi pepper làm mọi link MCP chết ngay (dùng khi cần vô hiệu hoá toàn bộ link khẩn cấp, sau đó xoay key từng MCP để cấp link mới).

## Nhật ký & dung lượng
- Nhật ký MCP và nhật ký nhân sự lưu theo **partition tháng**; mặc định giữ **3 tháng** (giá trị khởi tạo từ `LOG_RETENTION_MONTHS`). Đổi trong **Cài đặt → Lưu trữ nhật ký** (1–24 tháng, riêng từng loại). Job `logs.maintain` chạy 03:15 hằng ngày (theo `APP_TIMEZONE`) tạo trước partition 3 tháng tới và xoá partition quá hạn — dữ liệu luôn được giữ **ít nhất** N tháng.
- Ước lượng: ~1–2 KB/lượt gọi MCP. 10.000 lượt/ngày × 3 tháng ≈ 1–2 GB.
- Kiểm tra dung lượng: **Cài đặt → Thông tin hệ thống**, hoặc:
  ```bash
  docker compose exec db psql -U adsmcp -d adsmcp -c "select pg_size_pretty(pg_database_size('adsmcp'));"
  df -h /var/lib/docker
  ```
- Log container (stdout) được Docker xoay vòng: tối đa 5 file × 20 MB mỗi service. Access log của Caddy đã che `/mcp/<key>`, token link tạm video `/dl/<token>` và bỏ header `Authorization`/`Cookie`.
- Link tạm video Google Drive (`/dl/…`) hết hạn sau 60 phút; job `drive.cleanup` (03:50 hằng ngày) xoá bản ghi đã hết hạn quá 24 giờ. Job `drive.health` (phút 40, mỗi 6 giờ) kiểm tra lại service account và các thư mục / sheet đã khai báo - trạng thái hiện ở **Kết nối → Google Drive**.
- Video lớn từ Google Drive (Meta > 20 MB, TikTok > 10 MB) được **worker** tải lên ở nền (job `media.video_upload`, mỗi lần một video, có thể mất vài phút); AI xem tiến độ bằng `ads_get_media_upload`. Nếu container worker dừng, lượt tải nằm chờ; lượt tải bị treo (không báo tiến độ 30 phút) được job `media.upload_sweep` đánh dấu lỗi - chỉ cần yêu cầu AI tải lại.
- Video tải qua link tạm đi Drive → máy chủ → nền tảng: tốn băng thông VPS cả chiều vào lẫn ra (không ghi đĩa).

## Giám sát
- **Healthcheck**: `docker compose ps` — `web` phải `healthy`. Giám sát từ ngoài (UptimeRobot, Better Stack…): kiểm tra `https://<tên-miền>/api/health` trả HTTP 200 mỗi 1–5 phút.
- **Cảnh báo trong app**: trang **Tổng quan** hiện token lỗi/sắp hết hạn (Meta 60 ngày, Google refresh token ở Testing 7 ngày…; token TikTok không hết hạn, chỉ mất khi bị thu hồi), tỉ lệ lỗi MCP 24h; chuông thông báo trên thanh trên cùng.
- **Cảnh báo qua Telegram** (tuỳ chọn): thêm kênh Telegram (**Kết nối → Thêm kết nối → Kênh thông báo**), đăng ký sự kiện *kết nối quảng cáo* và (admin) *cập nhật hệ thống*. Máy chủ cần ra Internet tới `api.telegram.org` (HTTPS 443). Biến `TELEGRAM_API_BASE_URL` **tuỳ chọn** (mặc định `https://api.telegram.org`; chỉ đổi khi dùng Bot API server riêng, phải là https). Lịch sử gửi tin xem ở trang chi tiết kênh, được dọn theo thời hạn nhật ký MCP.
- **Phiên bản API**: **Cài đặt → Phiên bản API nền tảng** cảnh báo khi phiên bản đang dùng sắp ngừng (Meta, Google đổi phiên bản 3–4 lần/năm; TikTok hiện chỉ có v1.3) → cập nhật Ads MCP.
- **Tài nguyên**: `docker stats --no-stream`. Tham khảo: web ~250 MB, worker ~120 MB RAM.
- **Đĩa**: cảnh báo khi ổ < 20% trống (log + backup tăng dần).

## Mở rộng tải MCP (tuỳ chọn)
Khi lượng gọi MCP lớn làm chậm giao diện quản trị: bật service `mcp` (profile `scale`) chạy cùng image, chỉ phục vụ `/mcp/*`. Làm theo chú thích trong `docker-compose.yml` và `Caddyfile`, rồi `docker compose --profile scale up -d --no-build`.

## Đặt sau Cloudflare
Làm theo [deploy-vps.md §9](deploy-vps.md#9-phương-án-b---cloudflare): `CADDY_CLIENT_IP=cloudflare` + `CADDY_TLS=cloudflare-origin` trong `.env` (Caddy chỉ tin `CF-Connecting-IP` từ dải IP Cloudflare và ghi đè `X-Forwarded-For` gửi vào app), SSL **Full (strict)** với chứng chỉ Origin CA, tắt Bot Fight Mode, WAF skip cho `/mcp/*`. Lưu ý:
- Cloudflare cắt request khi origin im lặng quá **125 giây** (lỗi 524) → lệnh MCP rất dài cần chia nhỏ.
- Thiếu cấu hình IP thật thì app thấy mọi khách là IP Cloudflare: khoá đăng nhập, rate limit và allowlist IP áp sai.
- Cập nhật dải IP Cloudflare định kỳ: `sh deploy/cloudflare/update-cloudflare-ips.sh && docker compose restart caddy`.
- **Video từ Google Drive** (link tạm `https://<tên-miền>/dl/…`, Meta/TikTok tự tải về): **không** bật Bot Fight Mode, challenge, Under Attack Mode hay Browser Integrity Check cho `/dl/*` (gói Pro trở lên: thêm `/dl/` vào rule WAF Skip như `/mcp/`), và **không** tạo rule "Cache Everything" cho `/dl/*`. Nếu bị chặn, nền tảng báo không tải được video.

## Bảo mật máy chủ
- Chỉ mở cổng 22, 80, 443: `ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443 && ufw enable`. Lưu ý Docker bỏ qua ufw với cổng được publish - compose này chỉ publish 80/443 của Caddy ra Internet; web chỉ publish ra `127.0.0.1`; Postgres không publish.
- SSH bằng key, tắt đăng nhập mật khẩu và đăng nhập root (README bước 3.6); bật cập nhật bảo mật tự động của hệ điều hành.
- Container chạy với rootfs chỉ đọc, bỏ capability, `no-new-privileges`, giới hạn RAM/tiến trình (đổi bằng `*_MEM_LIMIT` trong `.env`, xem deploy-vps §6.3). Caddy/cloudflared ở mạng `edge`, không thấy được `db`.
- Quyền file: `chmod 600 .env`; thư mục `backups/` chỉ root đọc được (dump chứa dữ liệu đã mã hoá + email người dùng).
- Nhân sự nghỉ việc: khoá tài khoản trong **Người dùng**, xoay key các MCP họ từng dùng, thu hồi token nền tảng nếu họ từng giữ.
