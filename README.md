<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/logo-am-ban.png">
    <img src="public/brand/logo-duong-ban.png" alt="Ads MCP by: Nextgency" height="72">
  </picture>
</p>

<h1 align="center">Ads MCP by: Nextgency - Hướng dẫn cài đặt lên VPS</h1>

> [!IMPORTANT]
> Phần mềm có bản quyền, không phải mã nguồn mở. Chỉ đơn vị được **Nextgency cấp quyền bằng văn bản** mới được cài đặt và sử dụng. Xem [LICENSE](LICENSE).

Hướng dẫn này viết cho người **không chuyên kỹ thuật**: làm lần lượt từng bước, mỗi lệnh chỉ cần **sao chép và dán**. Toàn bộ mất khoảng 30-45 phút.

Sau khi cài, đội của bạn dán token để kết nối **Meta, TikTok Ads (gồm GMV Max của TikTok Shop), Google Ads (gồm quảng cáo YouTube) và OpenAI Ads**, rồi tạo link MCP cho Claude, ChatGPT, Gemini. Có thể thêm **bot Telegram** để nhận cảnh báo kết nối, thông báo thay đổi do AI thực hiện và tin nhắn từ AI ngay trong nhóm chat, khai báo **thư mục Google Drive / Google Sheet** để AI lấy ảnh, video lên quảng cáo (xem [docs/huong-dan-google-drive.md](docs/huong-dan-google-drive.md)), và dán **token Apify** để AI lấy dữ liệu sàn TMĐT, mạng xã hội, Google (giá, đánh giá sản phẩm, quảng cáo của đối thủ…) rồi phân tích (xem [docs/huong-dan-apify.md](docs/huong-dan-apify.md)). Hướng dẫn dùng: [kết nối AI](docs/ket-noi-ai.md) · [Telegram](docs/huong-dan-telegram.md) · [Google Drive / Google Sheet](docs/huong-dan-google-drive.md) · [Apify](docs/huong-dan-apify.md).

> [!TIP]
> **Cài nhanh bằng 1 lệnh (khuyến nghị cho VPS Ubuntu 22.04/24.04, Debian 12/13 mới):** chép file `install-ads-mcp.sh` Nextgency gửi (hoặc `scripts/install-ads-mcp.sh` trong repo) lên VPS rồi chạy `sudo bash install-ads-mcp.sh`. Chỉ cần chuẩn bị tên miền, tài khoản GitHub đã được cấp quyền và **1 token** (PAT classic tích cả `repo` + `read:packages`); script hỏi lần lượt, tự cài Docker, tải phần mềm, tạo cấu hình, khởi chạy và in **mã cài đặt** để tạo admin. Chi tiết: [docs/deploy-vps.md mục 0](docs/deploy-vps.md#0-cài-nhanh-bằng-script-khuyến-nghị). Các bước dưới đây là cách cài tay.

> [!TIP]
> Bạn kết nối tài khoản GitHub chứa repo này với ChatGPT, Claude hoặc Gemini → cho AI đọc repo và hướng dẫn bạn deploy chi tiết nhé. Bạn cung cấp chi tiết cho AI biết là sẽ deploy trên đâu (VPS hay mini PC chạy Ubuntu Server), dùng bằng cách trỏ IP về VPS hay là Cloudflare Tunnel, trỏ IP về VPS thì có dùng Cloudflare và bật DNS only hay không. Bạn cung cấp đầy đủ ngữ cảnh để AI hướng dẫn chi tiết, gặp phần nào khó thì chụp ảnh màn hình xong gửi vào AI để nó hướng dẫn tiếp nhé.

## Mục lục

- [Bước 0. Chuẩn bị](#bước-0-chuẩn-bị)
- [Bước 1. Chuẩn bị quyền GitHub](#bước-1-chuẩn-bị-quyền-github)
- [Bước 2. Kết nối vào VPS](#bước-2-kết-nối-vào-vps)
- [Bước 3. Cài đặt máy chủ](#bước-3-cài-đặt-máy-chủ)
- [Bước 4. Tải phần mềm về VPS](#bước-4-tải-phần-mềm-về-vps)
- [Bước 5. Chọn cách đưa web ra Internet](#bước-5-chọn-cách-đưa-web-ra-internet)
- [Bước 6. Tạo file cấu hình](#bước-6-tạo-file-cấu-hình)
- [Bước 7. Khởi chạy](#bước-7-khởi-chạy)
- [Bước 8. Tạo tài khoản Admin](#bước-8-tạo-tài-khoản-admin)
- [Bước 9. Sao lưu file cấu hình](#bước-9-sao-lưu-file-cấu-hình)
- [Liên kết chính sách cho ứng dụng nền tảng quảng cáo](#liên-kết-chính-sách-cho-ứng-dụng-nền-tảng-quảng-cáo)
- [Cập nhật phiên bản mới](#cập-nhật-phiên-bản-mới)
- [Sao lưu và khôi phục dữ liệu](#sao-lưu-và-khôi-phục-dữ-liệu)
- [Các lệnh hay dùng](#các-lệnh-hay-dùng)
- [Lỗi thường gặp](#lỗi-thường-gặp)

---

## Bước 0. Chuẩn bị

Bạn cần có:

| Thứ cần có                                       | Ghi chú                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 VPS**                                        | Ubuntu 24.04 (khuyến nghị) hoặc Debian 12. Tối thiểu **1 vCPU, 2 GB RAM, 20 GB ổ cứng**. Nhà cung cấp gửi cho bạn: **địa chỉ IP**, **tên đăng nhập**, **mật khẩu**. |
| **1 tên miền**                                   | Ví dụ `congty.vn`. Phần mềm sẽ chạy ở một tên miền con, ví dụ `mcp.congty.vn`.                                                                                     |
| **1 tài khoản GitHub đã được Nextgency cấp quyền** | Gửi tên tài khoản GitHub cho Nextgency để được thêm quyền đọc. Nên dùng **tài khoản riêng cho việc này** (không dùng tài khoản cá nhân chứa dự án khác).             |
| **Máy tính**                                     | Windows 10/11 hoặc macOS, có trình duyệt.                                                                                                                          |

Trong hướng dẫn, thay các giá trị mẫu bằng thông tin của bạn:

| Giá trị mẫu     | Thay bằng                              |
| --------------- | -------------------------------------- |
| `mcp.congty.vn` | Tên miền con bạn dùng cho phần mềm     |
| `it@congty.vn`  | Email của bạn                          |
| `TEN_GITHUB`    | Tên tài khoản GitHub đã được cấp quyền |
| `IP_VPS`        | Địa chỉ IP của VPS                     |

---

## Bước 1. Chuẩn bị quyền GitHub

> [!NOTE]
> Cài bằng script (xem đầu trang) chỉ cần **1 token** tích cả `repo` và `read:packages`. Cài tay theo các bước dưới đây có thể dùng 2 token như mô tả, hoặc cùng 1 token đó cho cả 2 chỗ.

Nextgency thêm **tài khoản GitHub của bạn** vào kho phần mềm với quyền **chỉ đọc (Read)**. Bạn tạo **2 token** (2 "mật khẩu riêng") từ tài khoản đó, mỗi token chỉ làm **đúng 1 việc**:

| Token       | Dùng để                                                                   | Tích đúng 1 ô   |
| ----------- | ------------------------------------------------------------------------- | --------------- |
| **Token A** | Tải image Docker (phần mềm đã đóng gói)                                   | `read:packages` |
| **Token B** | Tải mã nguồn (`git clone`, `git pull`) và để phần mềm tự kiểm tra bản mới | `repo`          |

> [!WARNING]
> GitHub bắt buộc tích `repo` cho Token B (kho được chia sẻ cho tài khoản ngoài tổ chức chỉ dùng được loại token này). Quyền `repo` cho phép **đọc và ghi mọi kho (repo) của chính tài khoản GitHub đó**. Nếu tài khoản của bạn có kho quan trọng, nên **tạo một tài khoản GitHub riêng cho máy chủ** (ví dụ `congty-ads-server`) rồi gửi tên tài khoản này cho Nextgency để được thêm quyền (không bắt buộc). Với kho của Nextgency, tài khoản chỉ có quyền Read nên token không sửa được phần mềm.

### 1.1 Tạo Token A (tải image)

1. Đăng nhập GitHub bằng tài khoản đã được Nextgency cấp quyền.
2. Mở <https://github.com/settings/tokens/new> (Personal access tokens → **Tokens (classic)**).
3. **Note**: gõ `ads-mcp-vps-image`.
4. **Expiration**: chọn **1 năm** (hoặc _Custom_ ngày cụ thể). Ghi lịch nhắc gia hạn trước khi hết hạn 2 tuần.
5. Chỉ tích **☑ read:packages**. Không tích ô nào khác.
6. Kéo xuống cuối, bấm **Generate token**.
7. **Sao chép token ngay** (bắt đầu bằng `ghp_...`), lưu vào trình quản lý mật khẩu với ghi chú "Token A". GitHub chỉ hiện token **một lần**.

### 1.2 Tạo Token B (mã nguồn + kiểm tra bản mới)

Làm lại đúng như 1.1, chỉ khác:

- **Note**: gõ `ads-mcp-vps-repo`.
- Chỉ tích **☑ repo** (các ô con bên dưới tự được tích theo). Không tích `read:packages` hay ô nào khác.
- Lưu với ghi chú "Token B".

> Không gửi token cho người khác, không dán vào chat/email. Token hết hạn thì phần mềm vẫn chạy bình thường, chỉ không tải hoặc kiểm tra được bản mới: tạo token mới rồi làm lại bước 4.2 (Token A) hoặc 6.2 (Token B).

> [!IMPORTANT]
> **Đã cài theo hướng dẫn cũ** (có chạy lệnh `git config --global credential.helper store`, token nằm dạng chữ thường trên VPS)? Làm lần lượt trên VPS bằng user `deploy`:
>
> 1. Tạo Token A và Token B mới (bước 1.1, 1.2).
> 2. Xoá token cũ đang lưu trên VPS: `rm -f ~/.git-credentials && git config --global --unset credential.helper`. Từ giờ `git pull` sẽ hỏi `Username` (tên GitHub) và `Password` (dán Token B).
> 3. Đăng nhập lại kho image bằng Token A: chạy `docker logout ghcr.io`, rồi làm bước 4.2.
> 4. `cd /opt/ads-mcp && nano .env`, thay giá trị dòng `UPDATE_GITHUB_TOKEN=` bằng Token B, lưu lại, rồi chạy `docker compose up -d --no-build`.
> 5. Vào <https://github.com/settings/tokens>, bấm **Delete** ở token cũ.
> 6. Trong web, vào **Cài đặt → Cập nhật**, bấm **Kiểm tra ngay**: phải thấy phiên bản mới nhất, không báo lỗi.

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

Cài từ kho chính thức của Docker (dán cả khối):

```bash
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo "Chỉ hỗ trợ Ubuntu/Debian"; false ;; esac
apt -y install ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt update
apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker deploy
```

Đợi 1-3 phút đến khi chạy xong.

> Máy đã có Docker từ trước: kiểm tra bằng `docker --version` (bản **28** trở lên) và `docker compose version` (`v2` trở lên). Đủ thì bỏ qua khối trên, chỉ chạy `usermod -aG docker deploy`.
>
> Nhóm `docker` có quyền **tương đương root** trên máy chủ: chỉ thêm user quản trị tin cậy.

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

### 3.6 Đăng nhập bằng khoá SSH, tắt đăng nhập bằng mật khẩu

Mật khẩu SSH dễ bị dò. Bước này cho máy tính của bạn đăng nhập VPS bằng **khoá SSH**, rồi tắt hẳn đăng nhập bằng mật khẩu và đăng nhập `root`.

> Ngồi trực tiếp trên mini PC và không bao giờ SSH từ máy khác: có thể bỏ qua bước này.

**Trên máy tính của bạn** (mở **cửa sổ PowerShell/Terminal mới**, không gõ trong cửa sổ đang kết nối VPS):

- **Windows (PowerShell):**

  ```powershell
  ssh-keygen -t ed25519
  ```

  Bấm Enter 3 lần (giữ mặc định). Sau đó chép khoá lên VPS (thay `IP_VPS`, nhập mật khẩu của `deploy` khi được hỏi):

  ```powershell
  type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh deploy@IP_VPS "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
  ```

- **macOS (Terminal):**

  ```bash
  ssh-keygen -t ed25519
  ssh-copy-id deploy@IP_VPS
  ```

**Kiểm tra:** mở thêm **một cửa sổ mới**, gõ `ssh deploy@IP_VPS`. Phải vào được VPS **mà không hỏi mật khẩu VPS**. **Giữ nguyên cửa sổ cũ** đang kết nối, phòng khi có lỗi.

**Trên VPS** (trong cửa sổ vừa vào được bằng khoá; `sudo` hỏi mật khẩu của `deploy`):

```bash
sudo tee /etc/ssh/sshd_config.d/00-ads-mcp-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin)'
```

Dòng cuối phải in ra `passwordauthentication no` và `permitrootlogin no`. Từ giờ chỉ đăng nhập bằng `ssh deploy@IP_VPS` từ máy tính đã có khoá.

> [!WARNING]
> Mất khoá (đổi máy tính, cài lại Windows) là **không SSH vào VPS được nữa**. Khi đó dùng **console web** trong trang quản lý của nhà cung cấp VPS (mini PC: bàn phím và màn hình gắn trực tiếp) để đăng nhập `deploy` và thêm khoá mới. Nên sao lưu thư mục `.ssh` của máy tính ở nơi an toàn. Tuỳ chọn chống dò mật khẩu thêm: fail2ban ([docs/deploy-vps.md](docs/deploy-vps.md) mục 3.6).

---

## Bước 4. Tải phần mềm về VPS

### 4.1 Tải mã nguồn

```bash
sudo mkdir -p /opt/ads-mcp && sudo chown deploy: /opt/ads-mcp
git clone https://github.com/schhung1822/nextgency-mcp-ads.git /opt/ads-mcp
```

- Có thể được hỏi mật khẩu của `deploy` (do lệnh `sudo`): nhập mật khẩu đã đặt ở bước 3.1.
- `Username`: nhập `TEN_GITHUB` = **tên đăng nhập (username) GitHub** của tài khoản đã tạo token ở bước 1. Xem username: đăng nhập GitHub → bấm avatar góc trên bên phải → dòng in đậm. **Không** nhập email.
- `Password`: **dán Token B** ở bước 1.2 (không hiện ký tự), Enter. **Không** nhập mật khẩu GitHub, GitHub chỉ nhận token.

Token **không** được lưu trên VPS: mỗi lần `git pull` (khi cập nhật) sẽ hỏi lại `Username` và `Password` (Token B). **Không** chạy `git config credential.helper store` (lệnh đó lưu token thành chữ thường trên ổ đĩa).

> Tuỳ chọn, đỡ phải dán lại nhiều lần trong 1 buổi làm việc: `git config --global credential.helper 'cache --timeout=900'` (chỉ nhớ token trong RAM 15 phút).

### 4.2 Đăng nhập kho image

Dán nguyên khối lệnh dưới đây (thay `TEN_GITHUB`); khi thấy dòng `Dán Token A rồi Enter:` thì **dán Token A** ở bước 1.1 (không hiện ký tự) rồi Enter:

```bash
cd /opt/ads-mcp
read -rsp "Dán Token A rồi Enter: " CR_PAT; echo
printf '%s' "$CR_PAT" | docker login ghcr.io -u TEN_GITHUB --password-stdin; unset CR_PAT
```

Thấy `Login Succeeded` là đúng (cảnh báo `credentials are stored unencrypted` là bình thường trên máy chủ Linux).

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

Để phần mềm tự kiểm tra và tải bản cập nhật. Dán nguyên khối lệnh dưới đây; khi thấy dòng `Dán Token B rồi Enter:` thì **dán Token B** ở bước 1.2 (không hiện ký tự) rồi Enter:

```bash
read -rsp "Dán Token B rồi Enter: " GH_TOKEN; echo
echo "UPDATE_GITHUB_TOKEN=$GH_TOKEN" >> .env; unset GH_TOKEN
echo "UPDATER_DOCKER_CONFIG=$HOME/.docker" >> .env
grep -cE "^UPDATE_GITHUB_TOKEN=(ghp_|github_pat_)" .env
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

## Liên kết chính sách cho ứng dụng nền tảng quảng cáo

Ứng dụng nhà phát triển (Meta App Dashboard → **App settings → Basic** / *Cài đặt ứng dụng → Thông tin cơ bản*: *URL chính sách quyền riêng tư*, *URL điều khoản dịch vụ*, *Xoá dữ liệu người dùng → URL hướng dẫn xoá dữ liệu*; TikTok for Developers → thông tin app: *Terms of Service URL*, *Privacy Policy URL*; Google Cloud → **màn hình đồng ý OAuth (Branding)** cho Google Ads/YouTube: liên kết chính sách quyền riêng tư và điều khoản; OpenAI tương tự) cần các trang công khai. Mỗi bản cài đặt đã có sẵn 3 trang, **không cần đăng nhập**, tiếng Việt + bản tiếng Anh:

| Trang | Địa chỉ |
|---|---|
| Chính sách quyền riêng tư | `https://mcp.congty.vn/privacy` |
| Điều khoản dịch vụ | `https://mcp.congty.vn/terms` |
| Hướng dẫn xoá dữ liệu | `https://mcp.congty.vn/data-deletion` |

1. Đăng nhập bằng Admin → **Cài đặt → Thông tin pháp lý**: nhập **Tên đơn vị vận hành** (công ty của bạn - bên chịu trách nhiệm về dữ liệu) và **Email liên hệ quyền riêng tư** → Lưu. Để trống thì trang dùng tên miền và ghi "quản trị viên hệ thống".
2. Lấy liên kết: thanh bên trái, dưới tên tài khoản, khối **Liên kết cho ứng dụng** - bấm tên trang để mở, bấm biểu tượng sao chép để lấy địa chỉ đầy đủ (điện thoại: tab **Menu**).
3. Dán các địa chỉ vào ứng dụng Meta, TikTok, Google Cloud (màn hình đồng ý OAuth) hoặc OpenAI.

---

## Cập nhật phiên bản mới

**Cách 1 - Trong web (khuyến nghị):** khi có bản mới, Admin thấy thông báo ở menu tài khoản. Vào **Cài đặt → Cập nhật** → bấm **Cập nhật lên vX.Y.Z** → nhập lại mật khẩu. Hệ thống tự sao lưu dữ liệu, tải bản mới, **kiểm tra chữ ký số của Nextgency** (bản không có chữ ký bị từ chối), khởi động lại (web gián đoạn khoảng 1-2 phút) và **tự quay về bản cũ nếu lỗi**.

> Ghi chú phát hành yêu cầu lấy cấu hình mới (`git pull`)? Chạy trước khi bấm Cập nhật (git hỏi `Username` và `Password` = Token B):
>
> ```bash
> cd /opt/ads-mcp && git pull --ff-only && docker compose up -d --no-build
> ```

**Cách 2 - Chạy lệnh** (dùng khi ghi chú phát hành yêu cầu, hoặc nút Cập nhật không dùng được). Thay `X.Y.Z` bằng số phiên bản mới (không có chữ `v`):

```bash
cd /opt/ads-mcp
docker compose exec -T db pg_dump -U adsmcp -d adsmcp -Fc > backups/truoc-cap-nhat-$(date +%F).dump
git pull --ff-only
sed -i 's/^APP_VERSION=.*/APP_VERSION=X.Y.Z/' .env
docker compose pull
docker compose up -d --no-build
```

---

## Sao lưu và khôi phục dữ liệu

Phần mềm **tự sao lưu cơ sở dữ liệu mỗi ngày** vào thư mục `/opt/ads-mcp/backups`, giữ 14 ngày. Nên định kỳ tải thư mục này về máy hoặc đồng bộ lên dịch vụ lưu trữ khác.

> File sao lưu chứa email người dùng, mật khẩu đã băm và token quảng cáo đã mã hoá: giữ **bí mật** như file `.env`, **mã hoá trước khi** đưa lên dịch vụ lưu trữ (ví dụ rclone `crypt`, restic - xem [docs/van-hanh.md](docs/van-hanh.md)) và không để chung chỗ với bản sao `.env`.

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
| `git clone` / `git pull` báo `Authentication failed` / `Repository not found`                   | Sai `Username`, Token B sai/hết hạn (phải tích **repo**), hoặc tài khoản GitHub chưa được Nextgency cấp quyền. Kiểm tra lại bước 1.2 rồi chạy lại lệnh, dán đúng Token B khi được hỏi `Password`.                            |
| `docker compose pull` báo `denied` / `unauthorized`                                             | Đăng nhập lại kho image bằng Token A còn hạn (chỉ tích **read:packages**): làm lại bước 4.2.                                                                                                                               |
| Mọi lệnh `docker compose` báo `Thiếu APP_VERSION trong .env`                                    | `nano .env`, đặt dòng `APP_VERSION=` bằng phiên bản đang chạy (ví dụ `APP_VERSION=1.0.2`, không có chữ `v`; xem trang Releases trên GitHub), lưu rồi chạy lại lệnh.                                                        |
| `permission denied ... docker.sock`                                                             | `sudo usermod -aG docker deploy`, rồi `exit` và đăng nhập lại (`ssh deploy@IP_VPS` hoặc `su - deploy`) - xem bước 3.5.                                                                                                     |
| Bước 3 báo `Permission denied` / `Only root may add a user`                                     | Đang ở user thường: gõ `sudo -i` rồi chạy lại (xem bước 2).                                                                                                                                                                |
| `ssh: Could not resolve hostname deploy`                                                        | Gõ thiếu IP: dùng `ssh deploy@IP_VPS`, hoặc `su - deploy` nếu đang ngồi trên chính máy chủ.                                                                                                                                |
| Trang web hiện ra nhưng **mất giao diện** (chữ trắng đen, không màu), F12 báo `ERR_ABORTED 499` | Sub domain bắt đầu bằng `ads.` bị trình chặn quảng cáo/diệt virus chặn. Đổi sang `mcp.` (sửa Cloudflare/DNS + `sed -i 's/ads\./mcp./g' .env` rồi `docker compose up -d --no-build`). Thử thêm Ctrl+F5 hoặc cửa sổ ẩn danh. |
| `migrate` ở trạng thái `exited (1)`                                                             | Xem lỗi: `docker compose logs migrate`. Gửi nội dung lỗi cho Nextgency.                                                                                                                                                      |
| Cách A: trình duyệt báo lỗi chứng chỉ / không vào được                                          | Kiểm tra bản ghi A đúng `IP_VPS` (`getent hosts mcp.congty.vn`), Cloudflare để đám mây **xám**, đã mở cổng 80/443 ở bước 3.4. Xem `docker compose logs caddy`.                                                             |
| Cách B: Cloudflare báo lỗi **1033**                                                             | Tunnel chưa kết nối: kiểm tra `TUNNEL_TOKEN` trong `.env`, xem `docker compose logs --tail=50 cloudflared`.                                                                                                                |
| Cách B: lỗi **502**                                                                             | Public hostname phải là `HTTP` + `caddy:80`.                                                                                                                                                                               |
| Cách B: lỗi **chuyển hướng quá nhiều lần**                                                      | File `.env` không tạo bằng `--ssl tunnel`. Làm lại bước 6 với `--ssl tunnel --force`.                                                                                                                                      |
| Trang Cập nhật báo "Chưa bật"                                                                   | `docker compose ps -a updater` phải `running`. Kiểm tra `.env` có dòng `COMPOSE_PROFILES=updater` và `UPDATER_DOCKER_CONFIG`, rồi `docker compose up -d --no-build`.                                                       |
| Trang Cập nhật báo "Không tìm thấy bản phát hành nào"                                           | Token B sai/hết hạn hoặc tài khoản GitHub mất quyền Read: tạo Token B mới (bước 1.2), sửa dòng `UPDATE_GITHUB_TOKEN=` trong `.env`, rồi `docker compose up -d --no-build`.                                                 |
| Cập nhật lỗi ở bước "tải image": `không xác minh được chữ ký số`                                | Máy chủ phải ra Internet được tới `ghcr.io` và Sigstore (`*.sigstore.dev`): kiểm tra tường lửa chiều ra rồi bấm Cập nhật lại. Bản đang chạy không bị ảnh hưởng. Không tự tắt bước kiểm tra chữ ký: hỏi Nextgency trước.      |
| Admin bị khoá tài khoản                                                                         | `docker compose run --rm web node dist/cli.mjs unban email@congty.vn`                                                                                                                                                      |
| AI báo lỗi **524** (Cách B)                                                                     | Yêu cầu quá 125 giây: nhờ AI chia nhỏ (ít tài khoản hơn, khoảng ngày ngắn hơn).                                                                                                                                            |

Cần hỗ trợ: gửi cho Nextgency kết quả của `docker compose ps -a` và `docker compose logs --tail=100 <tên dịch vụ lỗi>`. **Không gửi nội dung file `.env`.**
