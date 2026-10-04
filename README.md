<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/logo-am-ban.png">
    <img src="public/brand/logo-duong-ban.png" alt="Ads MCP by: noti.vn" height="72">
  </picture>
</p>

<h1 align="center">Ads MCP by: noti.vn - Hướng dẫn cài đặt lên VPS</h1>

> [!IMPORTANT]
> Phần mềm có bản quyền, không phải mã nguồn mở. Chỉ đơn vị được **noti.vn cấp quyền bằng văn bản** mới được cài đặt và sử dụng. Xem [LICENSE](LICENSE).

Hướng dẫn này viết cho người **không chuyên kỹ thuật**: làm lần lượt từng bước, mỗi lệnh chỉ cần **sao chép và dán**. Toàn bộ mất khoảng 30-45 phút.

> [!TIP]
> Bạn kết nối tài khoản GitHub chứa repo này với ChatGPT, Claude hoặc Gemini → cho AI đọc repo và hướng dẫn bạn deploy chi tiết nhé. Bạn cung cấp chi tiết cho AI biết là sẽ deploy trên đâu (VPS hay mini PC chạy Ubuntu Server), dùng bằng cách trỏ IP về VPS hay là Cloudflare Tunnel, trỏ IP về VPS thì có dùng Cloudflare và bật DNS only hay không. Bạn cung cấp đầy đủ ngữ cảnh để AI hướng dẫn chi tiết, gặp phần nào khó thì chụp ảnh màn hình xong gửi vào AI để nó hướng dẫn tiếp nhé.

## Mục lục

- [Bước 0. Chuẩn bị](#bước-0-chuẩn-bị)
- [Bước 1. Tạo token GitHub](#bước-1-tạo-token-github)
- [Bước 2. Kết nối vào VPS](#bước-2-kết-nối-vào-vps)
- [Bước 3. Cài đặt máy chủ](#bước-3-cài-đặt-máy-chủ)
- [Bước 4. Tải phần mềm về VPS](#bước-4-tải-phần-mềm-về-vps)
- [Bước 5. Chọn cách đưa web ra Internet](#bước-5-chọn-cách-đưa-web-ra-internet)
- [Bước 6. Tạo file cấu hình](#bước-6-tạo-file-cấu-hình)
- [Bước 7. Khởi chạy](#bước-7-khởi-chạy)
- [Bước 8. Tạo tài khoản Admin](#bước-8-tạo-tài-khoản-admin)
- [Bước 9. Sao lưu file cấu hình](#bước-9-sao-lưu-file-cấu-hình)
- [Cập nhật phiên bản mới](#cập-nhật-phiên-bản-mới)
- [Sao lưu và khôi phục dữ liệu](#sao-lưu-và-khôi-phục-dữ-liệu)
- [Các lệnh hay dùng](#các-lệnh-hay-dùng)
- [Lỗi thường gặp](#lỗi-thường-gặp)

---

## Bước 0. Chuẩn bị

Bạn cần có:

| Thứ cần có                                       | Ghi chú                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 VPS**                                        | Ubuntu 24.04 (khuyến nghị) hoặc Debian 12. Tối thiểu **2 CPU, 2 GB RAM, 20 GB ổ cứng**. Nhà cung cấp gửi cho bạn: **địa chỉ IP**, **tên đăng nhập**, **mật khẩu**. |
| **1 tên miền**                                   | Ví dụ `congty.vn`. Phần mềm sẽ chạy ở một tên miền con, ví dụ `mcp.congty.vn`.                                                                                     |
| **1 tài khoản GitHub đã được noti.vn cấp quyền** | Gửi tên tài khoản GitHub cho noti.vn để được thêm quyền đọc. Nên dùng **tài khoản riêng cho việc này** (không dùng tài khoản cá nhân chứa dự án khác).             |
| **Máy tính**                                     | Windows 10/11 hoặc macOS, có trình duyệt.                                                                                                                          |

Trong hướng dẫn, thay các giá trị mẫu bằng thông tin của bạn:

| Giá trị mẫu     | Thay bằng                              |
| --------------- | -------------------------------------- |
| `mcp.congty.vn` | Tên miền con bạn dùng cho phần mềm     |
| `it@congty.vn`  | Email của bạn                          |
| `TEN_GITHUB`    | Tên tài khoản GitHub đã được cấp quyền |
| `IP_VPS`        | Địa chỉ IP của VPS                     |

---

## Bước 1. Tạo token GitHub

Token là "mật khẩu riêng" để VPS tải phần mềm từ GitHub. **Một token dùng cho cả 3 việc**: tải mã nguồn, tải image Docker, và kiểm tra bản cập nhật mới.

1. Đăng nhập GitHub bằng tài khoản đã được cấp quyền.
2. Mở <https://github.com/settings/tokens/new> (Personal access tokens → **Tokens (classic)**).
3. **Note**: gõ `ads-mcp-vps`.
4. **Expiration**: chọn **1 năm** (hoặc _Custom_ ngày cụ thể). Ghi lịch nhắc gia hạn trước khi hết hạn.
5. Tích đúng 2 ô:
   - ☑ **repo**
   - ☑ **read:packages**
6. Kéo xuống cuối, bấm **Generate token**.
7. **Sao chép token ngay** (bắt đầu bằng `ghp_...`) và lưu vào nơi an toàn. GitHub chỉ hiện token **một lần**.

> Token này chỉ đọc được các dự án mà tài khoản GitHub của bạn có quyền. Không gửi token cho người khác.

---

## Bước 2. Kết nối vào VPS

Mọi lệnh từ bước 3 trở đi được gõ **trên VPS** qua cửa sổ dòng lệnh.

**Windows:** bấm phím Windows, gõ `PowerShell`, mở **Windows PowerShell**.
**macOS:** mở ứng dụng **Terminal**.

Gõ lệnh sau (thay `IP_VPS` bằng IP của bạn), bấm Enter:

```bash
ssh root@IP_VPS
```

- Lần đầu sẽ hỏi `Are you sure you want to continue connecting?` → gõ `yes`, Enter.
- Nhập mật khẩu VPS (khi gõ **không hiện ký tự**, cứ gõ rồi Enter).
- Thấy dòng dạng `root@ten-may:~#` là đã vào được VPS.

> **Nếu bạn đăng nhập bằng user thường** (nhà cung cấp cho user `ubuntu`, hoặc bạn ngồi trực tiếp trên mini PC, dòng nhắc dạng `ten-user@ten-may:~$`): gõ `sudo -i`, nhập mật khẩu của user đó. Dòng nhắc đổi thành `root@ten-may:~#` thì mới làm tiếp bước 3. Nếu không, các lệnh sẽ báo `Permission denied`.

> **Cách dán lệnh:** trong PowerShell/Terminal, bấm **chuột phải** (Windows) hoặc **Cmd+V** (macOS). Nên dán **từng khối lệnh** trong hướng dẫn, đợi chạy xong mới dán khối tiếp theo.

---

## Bước 3. Cài đặt máy chủ

### 3.1 Cập nhật hệ thống và tạo user riêng

Không nên chạy phần mềm bằng `root`. Tạo user tên `deploy` (dán cả khối):

```bash
apt update && apt -y upgrade
timedatectl set-timezone Asia/Ho_Chi_Minh
adduser --gecos "" deploy
usermod -aG sudo deploy
```

Lệnh `adduser` sẽ hỏi mật khẩu cho user `deploy` 2 lần, hãy đặt mật khẩu mạnh và ghi lại.

### 3.2 Cài Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

Đợi 1-3 phút đến khi chạy xong.

> Nếu thấy cảnh báo `the "docker" command appears to already exist` và `sleep 20`: máy đã có Docker từ trước. Bấm **Ctrl+C** để huỷ, kiểm tra bằng `docker --version` và `docker compose version`. Nếu Docker từ bản **28** trở lên và có `Docker Compose version v2` trở lên thì dùng luôn; nếu không thì chạy lại lệnh cài và để chạy hết. Sau khi huỷ, chạy riêng lại lệnh `usermod -aG docker deploy`.

### 3.3 Tạo bộ nhớ swap (cho VPS ít RAM)

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 3.4 Bật tường lửa

- Nếu bạn sẽ dùng **Cách A** ở bước 5 (đơn giản nhất):

  ```bash
  apt -y install ufw git
  ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
  ufw --force enable
  ```

- Nếu bạn sẽ dùng **Cách B - Cloudflare Tunnel**:

  ```bash
  apt -y install ufw git
  ufw allow OpenSSH
  ufw --force enable
  ```

### 3.5 Chuyển sang user `deploy`

Thoát khỏi `root`:

```bash
exit
```

Sau đó đăng nhập bằng user `deploy`, chọn đúng trường hợp:

- **Kết nối từ máy tính qua SSH**: gõ đủ cả `@` và IP (không gõ mỗi `ssh deploy`):

  ```bash
  ssh deploy@IP_VPS
  ```

- **Ngồi trực tiếp trên mini PC / đã dùng `sudo -i` ở bước 2**:

  ```bash
  su - deploy
  ```

Nhập mật khẩu của `deploy` đặt ở bước 3.1. Dòng nhắc phải là `deploy@ten-may:~$`.

Kiểm tra quyền dùng Docker:

```bash
docker ps
```

- Ra một bảng (kể cả bảng trống chỉ có dòng tiêu đề `CONTAINER ID ...`) là đúng.
- Nếu báo `permission denied ... docker.sock`: chạy `sudo usermod -aG docker deploy`, rồi `exit` và đăng nhập lại như trên (quyền mới chỉ có hiệu lực sau khi đăng nhập lại).

> Nếu dòng nhắc đã là `deploy@...` thì không cần `exit`, chỉ cần kiểm tra `docker ps` như trên.

---

## Bước 4. Tải phần mềm về VPS

### 4.1 Tải mã nguồn

```bash
sudo mkdir -p /opt/ads-mcp && sudo chown deploy: /opt/ads-mcp
git config --global credential.helper store
git clone https://github.com/notivn/Ads-MCP-simple.git /opt/ads-mcp
```

- Có thể được hỏi mật khẩu của `deploy` (do lệnh `sudo`): nhập mật khẩu đã đặt ở bước 3.1.
- `Username`: nhập `TEN_GITHUB` = **tên đăng nhập (username) GitHub** của tài khoản đã tạo token ở bước 1. Xem username: đăng nhập GitHub → bấm avatar góc trên bên phải → dòng in đậm. **Không** nhập email.
- `Password`: **dán token** ở bước 1 (không hiện ký tự), Enter. **Không** nhập mật khẩu GitHub, GitHub chỉ nhận token.

Token được lưu lại trên VPS để lần cập nhật sau không phải nhập nữa.

### 4.2 Đăng nhập kho image

```bash
cd /opt/ads-mcp
docker login ghcr.io -u TEN_GITHUB
```

`Password`: **dán token** ở bước 1, Enter. Thấy `Login Succeeded` là đúng.

---

## Bước 5. Chọn cách đưa web ra Internet

> [!CAUTION]
> **Tuyệt đối không dùng sub domain là `ads.example.com` vì sub domain `ads` dễ bị trình duyệt chặn gây setup lỗi.** Trình chặn quảng cáo / phần mềm diệt virus chặn các địa chỉ bắt đầu bằng `ads.`: trang hiện ra nhưng mất giao diện, F12 báo `ERR_ABORTED`. Dùng sub domain đề xuất là **`mcp`** (ví dụ `mcp.congty.vn`).

Chọn **một** trong hai cách:

|             | **Cách A - Caddy tự cấp SSL**                          | **Cách B - Cloudflare Tunnel**                               |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Phù hợp     | Đơn giản nhất, dùng được với mọi nhà cung cấp tên miền | Tên miền đã dùng Cloudflare; không muốn mở cổng nào trên VPS |
| Cần mở cổng | 80, 443                                                | Không                                                        |
| SSL         | Tự động (Let's Encrypt)                                | Cloudflare lo                                                |

> Cách nâng cao (Cloudflare proxy + chứng chỉ Origin, Nginx + Certbot): xem [docs/deploy-vps.md](docs/deploy-vps.md).

### Cách A - Caddy tự cấp SSL

Vào trang quản lý DNS của tên miền (nơi bạn mua tên miền, hoặc Cloudflare), thêm 1 bản ghi:

| Loại (Type) | Tên (Name/Host) | Giá trị (Value/IP) |
| ----------- | --------------- | ------------------ |
| `A`         | `mcp`           | `IP_VPS`           |

- Nếu dùng **Cloudflare**: để **Proxy status = DNS only** (đám mây **xám**).
- Đợi 5-15 phút để DNS cập nhật. Kiểm tra trên VPS: `getent hosts mcp.congty.vn` phải ra đúng `IP_VPS`.

Sau đó làm tiếp bước 6, dùng `--ssl auto`.

### Cách B - Cloudflare Tunnel

Tên miền phải đang quản lý trên Cloudflare.

1. Đăng nhập <https://one.dash.cloudflare.com> → chọn tài khoản.
2. Menu trái: **Networks → Tunnels** → **Create a tunnel** → chọn **Cloudflared** → **Next**.
3. **Tunnel name**: gõ `ads-mcp` → **Save tunnel**.
4. Màn hình _Install and run a connector_: chọn biểu tượng **Docker**. Bạn sẽ thấy một lệnh dạng:
   `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoi...`
   → **Chỉ sao chép phần token** (chuỗi dài bắt đầu bằng `eyJ` sau chữ `--token`), lưu tạm lại. **Không** chạy lệnh `docker run` này. → bấm **Next**.
5. Màn hình _Route traffic_ / _Public hostname_:
   - **Subdomain**: `mcp`
   - **Domain**: chọn `congty.vn`
   - **Service Type**: `HTTP`
   - **URL**: `caddy:80`
   - Không mở _Additional application settings_.
   - Bấm **Save** / **Complete setup**.

   Nếu Cloudflare báo đã có bản ghi DNS `mcp` thì vào DNS xoá bản ghi cũ đó rồi lưu lại.

6. Cấu hình thêm cho tên miền (trang quản lý tên miền trên <https://dash.cloudflare.com>):
   - **SSL/TLS → Edge Certificates**: bật **Always Use HTTPS**.
   - **Security → Bots**: tắt **Bot Fight Mode** (nếu bật, AI không gọi được MCP).
   - **Caching → Cache Rules → Create rule**: _Field_ `URI Path`, _Operator_ `starts with`, _Value_ `/mcp/` → **Or** → `URI Path` `starts with` `/api/` → _Cache eligibility_: **Bypass cache** → **Deploy**.

Sau đó làm tiếp bước 6, dùng `--ssl tunnel`.

---

## Bước 6. Tạo file cấu hình

### 6.1 Tạo file `.env`

File `.env` chứa mật khẩu cơ sở dữ liệu và khoá mã hoá, được tạo tự động với giá trị ngẫu nhiên.

**Cách A:**

```bash
cd /opt/ads-mcp
sh scripts/gen-secrets.sh --domain mcp.congty.vn --email it@congty.vn --ssl auto
```

**Cách B (Cloudflare Tunnel):**

```bash
cd /opt/ads-mcp
sh scripts/gen-secrets.sh --domain mcp.congty.vn --email it@congty.vn --ssl tunnel
```

Lần đầu chạy có thể mất 1-2 phút (tải công cụ tạo khoá). Chạy xong sẽ có file `/opt/ads-mcp/.env`.

### 6.2 Thêm token GitHub vào cấu hình

Để phần mềm tự kiểm tra và tải bản cập nhật. Dán nguyên khối lệnh dưới đây; khi thấy dòng `Dán token GitHub rồi Enter:` thì **dán token thật** ở bước 1 (không hiện ký tự) rồi Enter:

```bash
read -rsp "Dán token GitHub rồi Enter: " GH_TOKEN; echo
echo "UPDATE_GITHUB_TOKEN=$GH_TOKEN" >> .env; unset GH_TOKEN
echo "UPDATER_DOCKER_CONFIG=$HOME/.docker" >> .env
grep -c "^UPDATE_GITHUB_TOKEN=ghp_" .env
```

Dòng cuối in ra `1` là đúng. In ra `0` nghĩa là chưa dán đúng token: mở `nano .env`, sửa dòng `UPDATE_GITHUB_TOKEN=` ở cuối file.

### 6.3 (Chỉ Cách B) Dán token Cloudflare Tunnel

```bash
nano .env
```

Trong trình soạn thảo `nano`:

1. Dùng phím mũi tên tìm dòng `TUNNEL_TOKEN=`.
2. Đưa con trỏ ra sau dấu `=` và dán token `eyJ...` đã lưu ở Cách B (chuột phải hoặc Cmd+V).
3. Lưu: bấm **Ctrl+O**, rồi **Enter**. Thoát: bấm **Ctrl+X**.

### 6.4 Khoá quyền đọc file

```bash
chmod 600 .env
```

---

## Bước 7. Khởi chạy

```bash
cd /opt/ads-mcp
docker compose pull
docker compose up -d --no-build
```

- `pull` tải phần mềm về (vài phút lần đầu).
- `up -d` chạy phần mềm ở chế độ nền.

Đợi khoảng 1 phút rồi kiểm tra:

```bash
docker compose ps -a
```

Kết quả đúng:

| Dịch vụ                                | Trạng thái đúng                                  |
| -------------------------------------- | ------------------------------------------------ |
| `db`                                   | `running (healthy)`                              |
| `migrate`                              | `exited (0)` - chạy xong là tắt, **bình thường** |
| `web`                                  | `running (healthy)`                              |
| `worker`, `backup`, `updater`, `caddy` | `running`                                        |
| `cloudflared` (chỉ Cách B)             | `running (healthy)`                              |

Mở trình duyệt trên máy tính: `https://mcp.congty.vn/api/health` → thấy `{"ok":true}` là phần mềm đã chạy.

> Cách A: lần đầu Caddy cần 30-60 giây để xin chứng chỉ SSL. Nếu trình duyệt báo lỗi chứng chỉ, đợi 1 phút rồi tải lại.

---

## Bước 8. Tạo tài khoản Admin

Lấy mã cài đặt:

```bash
grep SETUP_TOKEN .env
```

Sao chép phần sau dấu `=`.

1. Mở `https://mcp.congty.vn/setup`.
2. Dán mã cài đặt, nhập tên, email, mật khẩu (tối thiểu 8 ký tự) → tạo tài khoản.
3. Đăng nhập bằng email và mật khẩu vừa tạo.
4. Khuyến nghị: vào **Tài khoản** → bật **xác thực 2 lớp (2FA)**, rồi vào **Cài đặt → Bảo mật** → bật **Bắt buộc 2FA cho quản trị viên**.

Trang `/setup` tự khoá sau khi đã có tài khoản Admin.

---

## Bước 9. Sao lưu file cấu hình

> [!WARNING]
> **Bước bắt buộc.** File `.env` chứa khoá mã hoá (`ENCRYPTION_KEYS`). **Mất file này là mất toàn bộ token quảng cáo đã lưu** và không khôi phục được.

Hiện nội dung file:

```bash
cat .env
```

Bôi đen toàn bộ nội dung, sao chép, lưu vào **trình quản lý mật khẩu** (Bitwarden, 1Password...) hoặc ghi chú bảo mật. **Không** gửi qua chat/email, **không** để chung chỗ với file sao lưu dữ liệu.

**Xong!** Phần mềm đã chạy tại `https://mcp.congty.vn`.

---

## Cập nhật phiên bản mới

**Cách 1 - Trong web (khuyến nghị):** khi có bản mới, Admin thấy thông báo ở menu tài khoản. Vào **Cài đặt → Cập nhật** → bấm **Cập nhật lên vX.Y.Z** → nhập lại mật khẩu. Hệ thống tự sao lưu dữ liệu, tải bản mới, khởi động lại (web gián đoạn khoảng 1-2 phút) và **tự quay về bản cũ nếu lỗi**.

**Cách 2 - Chạy lệnh** (dùng khi ghi chú phát hành yêu cầu, hoặc nút Cập nhật không dùng được). Thay `X.Y.Z` bằng số phiên bản mới (không có chữ `v`):

```bash
cd /opt/ads-mcp
docker compose exec -T db pg_dump -U adsmcp -d adsmcp -Fc > backups/truoc-cap-nhat-$(date +%F).dump
git pull
sed -i 's/^APP_VERSION=.*/APP_VERSION=X.Y.Z/' .env
docker compose pull
docker compose up -d --no-build
```

---

## Sao lưu và khôi phục dữ liệu

Phần mềm **tự sao lưu cơ sở dữ liệu mỗi ngày** vào thư mục `/opt/ads-mcp/backups`, giữ 14 ngày. Nên định kỳ tải thư mục này về máy hoặc đồng bộ lên dịch vụ lưu trữ khác.

Xem danh sách bản sao lưu:

```bash
ls -lh /opt/ads-mcp/backups
```

Sao lưu ngay:

```bash
cd /opt/ads-mcp
docker compose exec backup sh -c 'pg_dump -Fc -f /backups/adsmcp_manual_$(date +%F_%H%M%S).dump'
```

Khôi phục từ một bản sao lưu (**ghi đè dữ liệu hiện tại**; thay `TEN_FILE.dump` bằng tên file trong thư mục `backups`):

```bash
cd /opt/ads-mcp
docker compose stop web worker updater
docker compose exec backup pg_restore --clean --if-exists -d adsmcp /backups/TEN_FILE.dump
docker compose up -d --no-build
```

**Chuyển sang VPS mới:** làm lại bước 2 → 5, chép file `.env` **cũ** vào `/opt/ads-mcp/.env` (không chạy lại bước 6.1), chép file sao lưu vào `/opt/ads-mcp/backups/`, chạy `docker compose up -d --no-build db backup`, rồi chạy lệnh khôi phục ở trên.

---

## Các lệnh hay dùng

Luôn `cd /opt/ads-mcp` trước khi chạy:

| Việc                                                | Lệnh                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Xem trạng thái                                      | `docker compose ps -a`                                                         |
| Xem log web                                         | `docker compose logs --tail=100 web`                                           |
| Xem log tất cả (theo dõi liên tục, Ctrl+C để thoát) | `docker compose logs -f`                                                       |
| Khởi động lại                                       | `docker compose restart`                                                       |
| Dừng phần mềm                                       | `docker compose stop`                                                          |
| Chạy lại                                            | `docker compose up -d --no-build`                                              |
| Admin quên mật khẩu                                 | `docker compose run --rm web node dist/cli.mjs reset-password email@congty.vn` |
| Admin mất 2FA                                       | `docker compose run --rm web node dist/cli.mjs reset-2fa email@congty.vn`      |

---

## Lỗi thường gặp

| Hiện tượng                                                                                      | Cách xử lý                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git clone` báo `Authentication failed` / `Repository not found`                                | Token sai hoặc tài khoản GitHub chưa được noti.vn cấp quyền. Kiểm tra lại bước 1 (đã tích **repo**). Xoá token đã lưu: `rm ~/.git-credentials` rồi clone lại.                                                              |
| `docker compose pull` báo `denied` / `unauthorized`                                             | Chạy lại `docker login ghcr.io -u TEN_GITHUB` với token còn hạn (đã tích **read:packages**).                                                                                                                               |
| `permission denied ... docker.sock`                                                             | `sudo usermod -aG docker deploy`, rồi `exit` và đăng nhập lại (`ssh deploy@IP_VPS` hoặc `su - deploy`) - xem bước 3.5.                                                                                                     |
| Bước 3 báo `Permission denied` / `Only root may add a user`                                     | Đang ở user thường: gõ `sudo -i` rồi chạy lại (xem bước 2).                                                                                                                                                                |
| `ssh: Could not resolve hostname deploy`                                                        | Gõ thiếu IP: dùng `ssh deploy@IP_VPS`, hoặc `su - deploy` nếu đang ngồi trên chính máy chủ.                                                                                                                                |
| Trang web hiện ra nhưng **mất giao diện** (chữ trắng đen, không màu), F12 báo `ERR_ABORTED 499` | Sub domain bắt đầu bằng `ads.` bị trình chặn quảng cáo/diệt virus chặn. Đổi sang `mcp.` (sửa Cloudflare/DNS + `sed -i 's/ads\./mcp./g' .env` rồi `docker compose up -d --no-build`). Thử thêm Ctrl+F5 hoặc cửa sổ ẩn danh. |
| `migrate` ở trạng thái `exited (1)`                                                             | Xem lỗi: `docker compose logs migrate`. Gửi nội dung lỗi cho noti.vn.                                                                                                                                                      |
| Cách A: trình duyệt báo lỗi chứng chỉ / không vào được                                          | Kiểm tra bản ghi A đúng `IP_VPS` (`getent hosts mcp.congty.vn`), Cloudflare để đám mây **xám**, đã mở cổng 80/443 ở bước 3.4. Xem `docker compose logs caddy`.                                                             |
| Cách B: Cloudflare báo lỗi **1033**                                                             | Tunnel chưa kết nối: kiểm tra `TUNNEL_TOKEN` trong `.env`, xem `docker compose logs --tail=50 cloudflared`.                                                                                                                |
| Cách B: lỗi **502**                                                                             | Public hostname phải là `HTTP` + `caddy:80`.                                                                                                                                                                               |
| Cách B: lỗi **chuyển hướng quá nhiều lần**                                                      | File `.env` không tạo bằng `--ssl tunnel`. Làm lại bước 6 với `--ssl tunnel --force`.                                                                                                                                      |
| Trang Cập nhật báo "Chưa bật"                                                                   | `docker compose ps -a updater` phải `running`. Kiểm tra `.env` có dòng `COMPOSE_PROFILES=updater` và `UPDATER_DOCKER_CONFIG`, rồi `docker compose up -d --no-build`.                                                       |
| AI báo lỗi **524** (Cách B)                                                                     | Yêu cầu quá 125 giây: nhờ AI chia nhỏ (ít tài khoản hơn, khoảng ngày ngắn hơn).                                                                                                                                            |

Cần hỗ trợ: gửi cho noti.vn kết quả của `docker compose ps -a` và `docker compose logs --tail=100 <tên dịch vụ lỗi>`. **Không gửi nội dung file `.env`.**
