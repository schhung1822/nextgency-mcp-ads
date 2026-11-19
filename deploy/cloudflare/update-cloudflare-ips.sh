#!/bin/sh
# Ads MCP by: Nextgency - cập nhật danh sách dải IP của Cloudflare (phương án B / C+Cloudflare, docs/deploy-vps.md).
# Tải https://www.cloudflare.com/ips-v4 và /ips-v6, kiểm tra định dạng rồi ghi lại 2 file:
#   deploy/caddy/client-ip-cloudflare.caddy   (Caddy: trusted_proxies + client_ip_headers CF-Connecting-IP)
#   deploy/nginx/cloudflare-realip.conf       (Nginx: set_real_ip_from + real_ip_header CF-Connecting-IP)
# Dùng: sh deploy/cloudflare/update-cloudflare-ips.sh        (chạy ở thư mục gốc dự án hoặc bất kỳ đâu)
# Sau đó áp dụng:
#   Caddy: docker compose restart caddy
#   Nginx: sudo nginx -t && sudo systemctl reload nginx
# Cloudflare rất hiếm khi đổi dải IP; nên chạy lại vài tháng một lần (hoặc đặt cron hằng tuần, xem tài liệu).
# Lỗi mạng / dữ liệu lạ -> KHÔNG ghi đè file cũ (thoát mã 1).
set -eu

cd "$(dirname "$0")/../.."

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 20 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 20 -O - "$1"
  else
    echo "Cần curl hoặc wget." >&2
    exit 1
  fi
}

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

# Tải ra file trước (sh không có pipefail: lỗi mạng trong pipe sẽ bị bỏ qua). File của Cloudflare không có
# newline ở cuối -> awk 'NF' bỏ dòng trống VÀ luôn thêm newline để dòng cuối không bị mất/dính.
fetch https://www.cloudflare.com/ips-v4 > "$tmp_dir/v4.raw"
fetch https://www.cloudflare.com/ips-v6 > "$tmp_dir/v6.raw"
tr -d '\r' < "$tmp_dir/v4.raw" | awk 'NF' > "$tmp_dir/v4"
tr -d '\r' < "$tmp_dir/v6.raw" | awk 'NF' > "$tmp_dir/v6"

# Chỉ nhận đúng dạng CIDR; bất kỳ dòng lạ nào -> dừng (không ghi file cấu hình từ dữ liệu không tin cậy).
if grep -Ev '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' "$tmp_dir/v4" >/dev/null; then
  echo "Danh sách IPv4 từ Cloudflare có dòng không hợp lệ - giữ nguyên file cũ." >&2
  exit 1
fi
if grep -Ev '^[0-9a-fA-F:]+/[0-9]{1,3}$' "$tmp_dir/v6" >/dev/null; then
  echo "Danh sách IPv6 từ Cloudflare có dòng không hợp lệ - giữ nguyên file cũ." >&2
  exit 1
fi
n4=$(wc -l < "$tmp_dir/v4" | tr -d ' ')
n6=$(wc -l < "$tmp_dir/v6" | tr -d ' ')
if [ "$n4" -lt 5 ] || [ "$n6" -lt 3 ]; then
  echo "Danh sách quá ngắn (IPv4: $n4, IPv6: $n6) - giữ nguyên file cũ." >&2
  exit 1
fi

all=$(cat "$tmp_dir/v4" "$tmp_dir/v6" | tr '\n' ' ' | sed 's/ $//')

{
  echo "# Ads MCP by: Nextgency - Caddy đứng sau Cloudflare proxy (CADDY_CLIENT_IP=cloudflare). Nạp vào khối servers {}."
  echo "# SINH TỰ ĐỘNG bởi deploy/cloudflare/update-cloudflare-ips.sh từ"
  echo "# https://www.cloudflare.com/ips-v4 và https://www.cloudflare.com/ips-v6 - đừng sửa tay, hãy chạy lại script."
  echo "# Chỉ kết nối đến từ các dải này mới được tin header CF-Connecting-IP; Caddyfile ghi đè X-Forwarded-For bằng"
  echo "# {client_ip} nên app (tin hop đầu X-Forwarded-For) nhận đúng IP thật của khách."
  echo "trusted_proxies static $all"
  echo "client_ip_headers CF-Connecting-IP"
} > "$tmp_dir/caddy"

{
  echo "# Ads MCP by: Nextgency - Nginx đứng sau Cloudflare proxy: lấy IP thật của khách từ CF-Connecting-IP."
  echo "# SINH TỰ ĐỘNG bởi deploy/cloudflare/update-cloudflare-ips.sh từ"
  echo "# https://www.cloudflare.com/ips-v4 và https://www.cloudflare.com/ips-v6 - đừng sửa tay, hãy chạy lại script."
  echo "# include file này trong cả 2 khối server của deploy/nginx/ads-mcp.conf (xem docs/deploy-vps.md, phương án C)."
  while read -r cidr; do echo "set_real_ip_from $cidr;"; done < "$tmp_dir/v4"
  while read -r cidr; do echo "set_real_ip_from $cidr;"; done < "$tmp_dir/v6"
  echo "real_ip_header CF-Connecting-IP;"
} > "$tmp_dir/nginx"

mkdir -p deploy/caddy deploy/nginx
cp "$tmp_dir/caddy" deploy/caddy/client-ip-cloudflare.caddy.new && mv deploy/caddy/client-ip-cloudflare.caddy.new deploy/caddy/client-ip-cloudflare.caddy
cp "$tmp_dir/nginx" deploy/nginx/cloudflare-realip.conf.new && mv deploy/nginx/cloudflare-realip.conf.new deploy/nginx/cloudflare-realip.conf
chmod 644 deploy/caddy/client-ip-cloudflare.caddy deploy/nginx/cloudflare-realip.conf

echo "Đã cập nhật $n4 dải IPv4 + $n6 dải IPv6 của Cloudflare:"
echo "  deploy/caddy/client-ip-cloudflare.caddy"
echo "  deploy/nginx/cloudflare-realip.conf"
echo "Áp dụng: Caddy -> docker compose restart caddy | Nginx -> sudo nginx -t && sudo systemctl reload nginx"
