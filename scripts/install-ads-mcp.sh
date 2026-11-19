#!/usr/bin/env bash
# Ads MCP by: Nextgency - one-command VPS installer (Ubuntu 22.04/24.04, Debian 12/13; amd64/arm64).
#
#   sudo bash install-ads-mcp.sh                 # interactive (answers are read from the terminal)
#   curl -fsSL <private link> | sudo bash        # also works: answers come from /dev/tty
#   sudo ADS_MCP_GITHUB_TOKEN=... bash install-ads-mcp.sh --yes --domain mcp.congty.vn --email it@congty.vn \
#        --github-user congty-ads-server          # non-interactive
#
# What it does (same steps as docs/deploy-vps.md §2-§7 and §10b): pre-checks, GitHub token checks (one PAT classic
# with `repo` + `read:packages`), DNS / port checks, swap, UFW, Docker Engine from Docker's apt repository,
# `git clone` of the release tag, `docker login ghcr.io`, `.env` via scripts/gen-secrets.sh, `docker compose pull/up`,
# health checks, the `ads-mcp` helper command, and a final screen with the setup key.
# Re-running it on a server that already has <dir>/.env switches to repair mode: secrets are never regenerated.
#
# Secrets (GitHub token, Cloudflare Tunnel token) are only taken from hidden prompts or the environment variables
# ADS_MCP_GITHUB_TOKEN / ADS_MCP_TUNNEL_TOKEN - never from flags - and never reach argv of other processes, the log
# file, .git/config or the terminal. The setup key is printed on the final screen only (terminal, not the log).
#
# Test switch (maintainers only): ADS_MCP_INSTALL_TEST=1 skips the public IP / DNS comparison, accepts *.localhost
# test domains and checks HTTPS with `curl -k` against 127.0.0.1 (Caddy internal CA). Nothing else changes.

set -Eeuo pipefail

INSTALLER_VERSION="1.0.0"
REPO="schhung1822/nextgency-mcp-ads"
# public repository that publishes this installer (and the ads-mcp helper) - https://github.com/schhung1822/nextgency-mcp-ads
INSTALL_REPO_RAW="https://raw.githubusercontent.com/schhung1822/nextgency-mcp-ads/main/scripts"
REPO_URL="https://github.com/${REPO}.git"
MIN_VERSION="1.0.2" # first release whose gen-secrets.sh accepts --app-version
LOG="/var/log/ads-mcp-install.log"
CONF="/etc/ads-mcp.conf"
HELPER_BIN="/usr/local/bin/ads-mcp"
DOCKER_CONFIG_DIR="/root/.docker"
# Cloudflare proxy IPv4 ranges (https://www.cloudflare.com/ips-v4, same list as deploy/caddy/client-ip-cloudflare.caddy)
CF_RANGES_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"

# ------------------------------------------------------------------------------------------------------------------
# Options and state
# ------------------------------------------------------------------------------------------------------------------
OPT_DOMAIN="" OPT_EMAIL="" OPT_USER="" OPT_SSL="" OPT_VERSION="" OPT_DIR="/opt/ads-mcp"
OPT_FIREWALL="" OPT_UPDATER="" OPT_YES=0 OPT_FORCE_OS=0 OPT_SKIP_DNS=0
TEST_MODE=0
[[ "${ADS_MCP_INSTALL_TEST:-}" == "1" ]] && TEST_MODE=1

GH_TOKEN="" GH_USER="" GH_STATUS="" TOKEN_LOGIN="" TOKEN_EXPIRY_EPOCH="" MISSING_SCOPES=""
ENV_GITHUB_TOKEN="" ENV_TUNNEL_TOKEN="" TUNNEL_TOKEN_VALUE="" DOMAIN="" EMAIL="" SSL_MODE="" APP_VER="" LATEST_VER="" DIR=""
FIREWALL=1 UPDATER=1 MODE="install" HAVE_TTY=0
SWAP_STATE="" FIREWALL_STATE="" HTTPS_STATE="" UPDATER_STATE="" USER_COUNT="" CURRENT_STEP="khởi động"
START_TS=$(date +%s)
TMPD=""

# ------------------------------------------------------------------------------------------------------------------
# Output helpers (terminal + log; the log never receives secrets)
# ------------------------------------------------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\e[31m' C_GRN=$'\e[32m' C_YLW=$'\e[33m' C_BLU=$'\e[36m' C_BLD=$'\e[1m' C_DIM=$'\e[2m' C_RST=$'\e[0m'
else
  C_RED="" C_GRN="" C_YLW="" C_BLU="" C_BLD="" C_DIM="" C_RST=""
fi

log() { [[ -w "$LOG" ]] && printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG" || true; }
say() { printf '%s\n' "$*"; log "$*"; }
info() { printf '   %s\n' "$*"; log "   $*"; }
ok() { printf '   %s✔%s %s\n' "$C_GRN" "$C_RST" "$*"; log "   OK $*"; }
warn() { printf '   %s⚠%s %s\n' "$C_YLW" "$C_RST" "$*"; log "   WARN $*"; }
err() { printf '   %s✖%s %s\n' "$C_RED" "$C_RST" "$*" >&2; log "   ERROR $*"; }
die() {
  printf '\n%s✖ %s%s\n' "$C_RED$C_BLD" "$*" "$C_RST" >&2
  log "FATAL $*"
  [[ -w "$LOG" ]] && printf '  Nhật ký chi tiết: %s\n' "$LOG" >&2
  exit 1
}
step() {
  CURRENT_STEP="$2"
  printf '\n%s[%s] %s%s\n' "$C_BLU$C_BLD" "$1" "$2" "$C_RST"
  log "==== [$1] $2"
}

# Run a command with its output going to the log only. Returns the command's status.
run() {
  local desc=$1
  shift
  log "\$ ${desc}"
  if "$@" >>"$LOG" 2>&1; then return 0; fi
  return 1
}

# Show the last lines of the log (command output only - secrets never reach the log).
show_log_tail() {
  local n=${1:-25}
  [[ -r "$LOG" ]] || return 0
  printf '%s--- %s dòng cuối của %s ---%s\n' "$C_DIM" "$n" "$LOG" "$C_RST" >&2
  tail -n "$n" "$LOG" >&2 || true
  printf '%s---%s\n' "$C_DIM" "$C_RST" >&2
}

on_error() {
  local code=$1 line=$2
  trap - ERR
  printf '\n%s✖ Cài đặt dừng ở bước: %s%s (dòng %s, mã lỗi %s)\n' "$C_RED$C_BLD" "$CURRENT_STEP" "$C_RST" "$line" "$code" >&2
  log "FATAL step='$CURRENT_STEP' line=$line code=$code"
  show_log_tail 20
  printf '  Nhật ký chi tiết: %s\n' "$LOG" >&2
  printf '  Khắc phục rồi chạy lại đúng lệnh cài: script an toàn khi chạy lại (không tạo lại khoá bí mật).\n' >&2
  printf '  Cần hỗ trợ: gửi file nhật ký trên cho Nextgency (file không chứa token hay mật khẩu).\n' >&2
  exit "$code"
}

cleanup() {
  [[ -n "$TMPD" && -d "$TMPD" ]] && rm -rf "$TMPD"
  return 0
}

# ------------------------------------------------------------------------------------------------------------------
# Input helpers (always from /dev/tty, so `curl ... | sudo bash` works)
# ------------------------------------------------------------------------------------------------------------------
detect_tty() {
  if { : </dev/tty; } 2>/dev/null; then HAVE_TTY=1; else HAVE_TTY=0; fi
}

# ask VAR "Câu hỏi" [default] [flag-name] - re-asks are done by the caller
ask() {
  local __var=$1 __q=$2 __def=${3:-} __flag=${4:-} __ans=""
  if [[ $HAVE_TTY -ne 1 ]]; then
    [[ -n "$__def" ]] && { printf -v "$__var" '%s' "$__def"; return 0; }
    die "Thiếu thông tin \"$__q\" và không có bàn phím để hỏi. Chạy lại với tham số ${__flag:-tương ứng} (xem --help)."
  fi
  if [[ -n "$__def" ]]; then
    read -r -p "   ${__q} [${__def}]: " __ans </dev/tty || true
    [[ -z "$__ans" ]] && __ans=$__def
  else
    read -r -p "   ${__q}: " __ans </dev/tty || true
  fi
  # trim surrounding whitespace
  __ans="${__ans#"${__ans%%[![:space:]]*}"}"
  __ans="${__ans%"${__ans##*[![:space:]]}"}"
  printf -v "$__var" '%s' "$__ans"
}

# ask_secret VAR "Câu hỏi" - hidden input, nothing is echoed or logged
ask_secret() {
  local __var=$1 __q=$2 __ans=""
  [[ $HAVE_TTY -eq 1 ]] || die "Không có bàn phím để nhập \"$__q\". Truyền qua biến môi trường (xem --help)."
  read -r -s -p "   ${__q}: " __ans </dev/tty || true
  printf '\n' >/dev/tty
  __ans="${__ans//[[:space:]]/}"
  printf -v "$__var" '%s' "$__ans"
}

# ask_yn "Câu hỏi" Y|N -> 0 = yes. --yes (or no terminal) takes the default.
ask_yn() {
  local q=$1 def=$2 ans=""
  if [[ $OPT_YES -eq 1 || $HAVE_TTY -ne 1 ]]; then
    [[ "$def" == "Y" ]]
    return
  fi
  while true; do
    if [[ "$def" == "Y" ]]; then read -r -p "   ${q} [Y/n]: " ans </dev/tty || true; else read -r -p "   ${q} [y/N]: " ans </dev/tty || true; fi
    ans=${ans,,}
    case "$ans" in
      "") [[ "$def" == "Y" ]]; return ;;
      y | yes | c | co | có) return 0 ;;
      n | no | k | khong | không) return 1 ;;
      *) printf '   Gõ y (có) hoặc n (không).\n' ;;
    esac
  done
}

pause_enter() {
  [[ $HAVE_TTY -eq 1 ]] || return 0
  read -r -p "   $1" _ </dev/tty || true
}

# ------------------------------------------------------------------------------------------------------------------
# Validation helpers (pure functions - also used by the unit checks)
# ------------------------------------------------------------------------------------------------------------------
normalize_domain() {
  local d=${1,,}
  d=${d#http://}
  d=${d#https://}
  d=${d%%/*}
  printf '%s' "$d"
}

valid_domain() {
  local d=$1
  [[ ${#d} -le 253 ]] || return 1
  [[ "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || return 1
  if [[ $TEST_MODE -ne 1 ]]; then
    case "$d" in *.localhost | *.local | *.test | *.invalid | *.example | *.internal) return 1 ;; esac
  fi
  return 0
}

valid_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }
valid_github_user() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]]; }
valid_token_shape() { [[ ${#1} -ge 20 && "$1" =~ ^[A-Za-z0-9_]+$ ]]; }
valid_tunnel_token() { [[ ${#1} -ge 40 && "$1" =~ ^eyJ[A-Za-z0-9_=+/-]+$ ]]; }
valid_semver() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
valid_dir() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ && "/$1/" != *"/../"* && "$1" != "/" ]]; }

# version_ge A B -> 0 when A >= B (x.y.z)
version_ge() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  if ((a1 != b1)); then return $((a1 > b1 ? 0 : 1)); fi
  if ((a2 != b2)); then return $((a2 > b2 ? 0 : 1)); fi
  return $((a3 >= b3 ? 0 : 1))
}

# parse_scopes "<X-OAuth-Scopes value>" -> MISSING_SCOPES ("" = ok). write:packages implies read:packages.
parse_scopes() {
  local raw=$1 s has_repo=0 has_pkg=0
  local -a parts=()
  IFS=',' read -r -a parts <<<"$raw"
  for s in "${parts[@]}"; do
    s=${s//[[:space:]]/}
    case "$s" in
      repo) has_repo=1 ;;
      read:packages | write:packages) has_pkg=1 ;;
    esac
  done
  MISSING_SCOPES=""
  [[ $has_repo -eq 1 ]] || MISSING_SCOPES+="repo "
  [[ $has_pkg -eq 1 ]] || MISSING_SCOPES+="read:packages "
  MISSING_SCOPES=${MISSING_SCOPES% }
}

ip_to_int() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  printf '%s' $(((a << 24) + (b << 16) + (c << 8) + d))
}

# in_cidr IP CIDR
in_cidr() {
  local ip net bits mask
  ip=$(ip_to_int "$1")
  net=$(ip_to_int "${2%/*}")
  bits=${2#*/}
  mask=$(((0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF))
  return $(((ip & mask) == (net & mask) ? 0 : 1))
}

is_cloudflare_ip() {
  local r
  for r in $CF_RANGES_V4; do in_cidr "$1" "$r" && return 0; done
  return 1
}

# Vietnamese date dd/mm/yyyy from an epoch
vn_date() { date -d "@$1" '+%d/%m/%Y'; }

# ------------------------------------------------------------------------------------------------------------------
# .env editing in pure bash (values never appear in argv of another process)
# ------------------------------------------------------------------------------------------------------------------
env_get() {
  local key=$1 file=${2:-$DIR/.env} line
  [[ -r "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    if [[ "$line" == "$key="* ]]; then
      printf '%s' "${line#"$key"=}"
      return 0
    fi
  done <"$file"
}

# env_set KEY VALUE [file]: replace the active line; else replace a "# KEY=" placeholder; else append. Keeps mode 600.
env_set() {
  local key=$1 value=$2 file=${3:-$DIR/.env} line done=0 tmp
  local -a lines=()
  while IFS= read -r line || [[ -n "$line" ]]; do lines+=("${line%$'\r'}"); done <"$file"
  local i
  for i in "${!lines[@]}"; do
    if [[ "${lines[$i]}" == "$key="* ]]; then
      lines[i]="$key=$value"
      done=1
      break
    fi
  done
  if [[ $done -eq 0 ]]; then
    for i in "${!lines[@]}"; do
      if [[ "${lines[$i]}" == "# $key="* || "${lines[$i]}" == "#$key="* ]]; then
        lines[i]="$key=$value"
        done=1
        break
      fi
    done
  fi
  [[ $done -eq 1 ]] || lines+=("$key=$value")
  tmp="$file.tmp.$$"
  (
    umask 077
    printf '%s\n' "${lines[@]}" >"$tmp"
  )
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# ------------------------------------------------------------------------------------------------------------------
# GitHub API (token is fed to curl through a config on stdin, never through argv)
# ------------------------------------------------------------------------------------------------------------------
# gh_api METHOD PATH [ACCEPT] - response headers in $TMPD/h, body in $TMPD/b, status in $GH_STATUS
gh_api() {
  local method=$1 path=$2 accept=${3:-application/vnd.github+json}
  : >"$TMPD/h"
  : >"$TMPD/b"
  GH_STATUS=$(printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN" |
    curl -sS -X "$method" --max-time 25 \
      -H "Accept: $accept" -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: ads-mcp-installer' \
      -D "$TMPD/h" -o "$TMPD/b" -w '%{http_code}' -K - "https://api.github.com${path}" 2>>"$LOG") || GH_STATUS="000"
  log "GitHub API $method $path -> $GH_STATUS"
}

gh_header() {
  grep -i "^$1:" "$TMPD/h" 2>/dev/null | tail -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^[[:space:]]*//' || true
}

# validate_token: user, scopes, expiry, repository access (offers to accept a pending invitation).
# Returns 1 with a Vietnamese explanation when the token cannot be used.
validate_token() {
  local scopes exp inv_id
  TOKEN_LOGIN="" TOKEN_EXPIRY_EPOCH=""
  gh_api GET /user
  case "$GH_STATUS" in
    200) ;;
    401)
      err "Token GitHub sai, đã bị thu hồi hoặc đã hết hạn (GitHub trả 401)."
      info "Tạo token mới: https://github.com/settings/tokens/new → Tokens (classic), tích \"repo\" và \"read:packages\"."
      return 1
      ;;
    000) die "Không kết nối được tới api.github.com. Kiểm tra mạng / DNS của máy chủ rồi chạy lại." ;;
    *)
      err "GitHub trả mã $GH_STATUS khi kiểm tra token. Thử lại sau ít phút."
      return 1
      ;;
  esac
  TOKEN_LOGIN=$(jq -r '.login // empty' "$TMPD/b")
  if [[ -n "$GH_USER" && "${TOKEN_LOGIN,,}" != "${GH_USER,,}" ]]; then
    err "Token này thuộc tài khoản GitHub \"$TOKEN_LOGIN\", không phải \"$GH_USER\"."
    info "Tạo token từ đúng tài khoản \"$GH_USER\" (tài khoản đã được Nextgency cấp quyền), hoặc nhập lại tên tài khoản."
    return 1
  fi
  [[ -n "$GH_USER" ]] || GH_USER=$TOKEN_LOGIN
  if [[ "$GH_TOKEN" == github_pat_* ]] || ! grep -qi '^x-oauth-scopes:' "$TMPD/h"; then
    err "Đây là token loại fine-grained. Cần token loại classic (Personal access tokens → Tokens (classic))."
    info "Lý do: GitHub không cho token fine-grained đọc repo của Nextgency và kho image GHCR chỉ nhận token classic."
    return 1
  fi
  scopes=$(gh_header x-oauth-scopes)
  parse_scopes "$scopes"
  if [[ -n "$MISSING_SCOPES" ]]; then
    err "Token thiếu quyền: ${MISSING_SCOPES// /, } (token đang có: ${scopes:-không có quyền nào})."
    info "Sửa token ở https://github.com/settings/tokens → bấm vào token → tích thêm ô còn thiếu → Update token."
    return 1
  fi
  exp=$(gh_header github-authentication-token-expiration)
  if [[ -n "$exp" ]]; then
    TOKEN_EXPIRY_EPOCH=$(date -d "$exp" +%s 2>/dev/null || true)
  fi
  gh_api GET "/repos/${REPO}"
  if [[ "$GH_STATUS" == "404" || "$GH_STATUS" == "403" ]]; then
    gh_api GET "/user/repository_invitations?per_page=100"
    inv_id=""
    [[ "$GH_STATUS" == "200" ]] && inv_id=$(jq -r --arg r "${REPO,,}" '[.[] | select((.repository.full_name // "" | ascii_downcase) == $r) | .id][0] // empty' "$TMPD/b" 2>/dev/null || true)
    if [[ -n "$inv_id" ]]; then
      warn "Tài khoản \"$GH_USER\" có lời mời truy cập ${REPO} của Nextgency nhưng chưa chấp nhận."
      if ask_yn "Chấp nhận lời mời ngay?" Y; then
        gh_api PATCH "/user/repository_invitations/${inv_id}"
        if [[ "$GH_STATUS" == "204" ]]; then
          ok "Đã chấp nhận lời mời."
          sleep 2
          gh_api GET "/repos/${REPO}"
        else
          err "Không chấp nhận được lời mời (GitHub trả $GH_STATUS). Mở https://github.com/${REPO}/invitations để chấp nhận bằng tay."
          return 1
        fi
      else
        err "Cần chấp nhận lời mời trước: mở https://github.com/${REPO}/invitations bằng tài khoản \"$GH_USER\"."
        return 1
      fi
    fi
  fi
  if [[ "$GH_STATUS" != "200" ]]; then
    err "Tài khoản \"$GH_USER\" chưa được Nextgency cấp quyền truy cập phần mềm (GitHub trả $GH_STATUS)."
    info "Gửi tên tài khoản GitHub \"$GH_USER\" cho Nextgency để được cấp quyền Read, rồi chạy lại."
    return 1
  fi
  return 0
}

# resolve_release [x.y.z]: latest published release (not draft / prerelease, tag vX.Y.Z) or the pinned one.
resolve_release() {
  local want=${1:-} tag draft pre path
  if [[ -n "$want" ]]; then path="/repos/${REPO}/releases/tags/v${want}"; else path="/repos/${REPO}/releases/latest"; fi
  gh_api GET "$path"
  if [[ "$GH_STATUS" == "404" ]]; then
    if [[ -n "$want" ]]; then die "Không có bản phát hành v${want}. Xem danh sách: https://github.com/${REPO}/releases"; fi
    die "Chưa có bản phát hành nào trên https://github.com/${REPO}/releases. Liên hệ Nextgency."
  fi
  [[ "$GH_STATUS" == "200" ]] || die "GitHub trả mã $GH_STATUS khi lấy thông tin bản phát hành. Thử lại sau ít phút."
  tag=$(jq -r '.tag_name // empty' "$TMPD/b")
  draft=$(jq -r '.draft // false' "$TMPD/b")
  pre=$(jq -r '.prerelease // false' "$TMPD/b")
  [[ "$draft" == "false" && "$pre" == "false" && "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "Bản phát hành \"$tag\" không phải bản chính thức (bản nháp, bản thử hoặc tag không đúng dạng vX.Y.Z)."
  RELEASE_VER=${tag#v}
}

# ------------------------------------------------------------------------------------------------------------------
# Usage
# ------------------------------------------------------------------------------------------------------------------
usage() {
  cat <<EOF
Ads MCP by: Nextgency - trình cài đặt trên VPS (bản ${INSTALLER_VERSION})

Cách dùng:  sudo bash install-ads-mcp.sh [tuỳ chọn]

Không truyền tuỳ chọn nào: script hỏi lần lượt từng thông tin.
  --domain <tên miền>        Tên miền con chạy phần mềm, vd mcp.congty.vn
  --email <email>            Email nhận thông báo chứng chỉ Let's Encrypt (cách 1)
  --github-user <tài khoản>  Tài khoản GitHub đã được Nextgency cấp quyền
  --ssl auto|tunnel          auto = HTTPS tự động (mặc định), tunnel = Cloudflare Tunnel
  --no-firewall              Không bật tường lửa UFW
  --no-updater               Không bật cập nhật tự động
  --version <x.y.z>          Cài đúng phiên bản này (mặc định: bản mới nhất)
  --dir <thư mục>            Thư mục cài đặt (mặc định /opt/ads-mcp)
  --yes                      Không hỏi xác nhận, dùng giá trị mặc định
  --skip-dns-check           Bỏ qua kiểm tra bản ghi DNS (chứng chỉ có thể chưa cấp được)
  --force-os                 Cho phép chạy trên hệ điều hành chưa được kiểm thử
  -h, --help                 Hiện hướng dẫn này

Thông tin bí mật KHÔNG truyền bằng tham số (lộ trong lịch sử lệnh). Script hỏi ẩn, hoặc đọc từ biến môi trường:
  ADS_MCP_GITHUB_TOKEN       Token GitHub (PAT classic, tích "repo" + "read:packages")
  ADS_MCP_TUNNEL_TOKEN       Token Cloudflare Tunnel (chuỗi eyJ...), chỉ khi --ssl tunnel
Ví dụ:  sudo ADS_MCP_GITHUB_TOKEN=... bash install-ads-mcp.sh --domain mcp.congty.vn --email it@congty.vn --github-user congty-ads
Chạy lại trên máy đã cài: chế độ sửa chữa (giữ nguyên dữ liệu và khoá bí mật).
Hướng dẫn đầy đủ: docs/deploy-vps.md (mục "Cài nhanh bằng script").
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain | --email | --github-user | --ssl | --version | --dir)
        [[ $# -ge 2 && "$2" != --* ]] || die "Thiếu giá trị cho $1"
        case "$1" in
          --domain) OPT_DOMAIN=$2 ;;
          --email) OPT_EMAIL=$2 ;;
          --github-user) OPT_USER=$2 ;;
          --ssl) OPT_SSL=$2 ;;
          --version) OPT_VERSION=${2#v} ;;
          --dir) OPT_DIR=${2%/} ;;
        esac
        shift 2
        ;;
      --domain=* | --email=* | --github-user=* | --ssl=* | --version=* | --dir=*)
        local k=${1%%=*} v=${1#*=}
        set -- "$k" "$v" "${@:2}"
        ;;
      --no-firewall) OPT_FIREWALL=0; shift ;;
      --no-updater) OPT_UPDATER=0; shift ;;
      --yes | -y) OPT_YES=1; shift ;;
      --force-os) OPT_FORCE_OS=1; shift ;;
      --skip-dns-check) OPT_SKIP_DNS=1; shift ;;
      -h | --help) usage; exit 0 ;;
      --token | --github-token | --tunnel-token)
        die "Không truyền token bằng tham số (lộ trong lịch sử lệnh). Dùng biến môi trường ADS_MCP_GITHUB_TOKEN / ADS_MCP_TUNNEL_TOKEN hoặc để script hỏi."
        ;;
      *) die "Tham số không hợp lệ: $1 (xem --help)" ;;
    esac
  done
  if [[ -n "$OPT_SSL" && "$OPT_SSL" != "auto" && "$OPT_SSL" != "tunnel" ]]; then
    die "--ssl chỉ nhận auto hoặc tunnel. Cloudflare proxy / Nginx: cài tay theo docs/deploy-vps.md mục 9, 10."
  fi
  if [[ -n "$OPT_VERSION" ]]; then
    valid_semver "$OPT_VERSION" || die "--version phải có dạng x.y.z (vd 1.0.6)."
    version_ge "$OPT_VERSION" "$MIN_VERSION" || die "Trình cài đặt hỗ trợ từ bản ${MIN_VERSION} trở lên."
  fi
  valid_dir "$OPT_DIR" || die "--dir phải là đường dẫn tuyệt đối chỉ gồm chữ không dấu, số và . _ / - (vd /opt/ads-mcp)."
  # fail fast on bad flag values (interactive answers are re-asked later)
  if [[ -n "$OPT_DOMAIN" ]]; then
    OPT_DOMAIN=$(normalize_domain "$OPT_DOMAIN")
    valid_domain "$OPT_DOMAIN" || die "Tên miền không hợp lệ: \"$OPT_DOMAIN\". Ví dụ đúng: mcp.congty.vn (không có http://, không dấu cách)."
  fi
  [[ -z "$OPT_EMAIL" ]] || valid_email "$OPT_EMAIL" || die "Email không hợp lệ: \"$OPT_EMAIL\"."
  [[ -z "$OPT_USER" ]] || valid_github_user "$OPT_USER" || die "Tên tài khoản GitHub không hợp lệ: \"$OPT_USER\"."
  DIR=$OPT_DIR
}

# ------------------------------------------------------------------------------------------------------------------
# Steps
# ------------------------------------------------------------------------------------------------------------------
init_log() {
  (
    umask 077
    touch "$LOG"
  )
  chmod 600 "$LOG"
  {
    printf '\n========== %s ads-mcp installer %s (test=%s) ==========\n' "$(date '+%F %T %z')" "$INSTALLER_VERSION" "$TEST_MODE"
  } >>"$LOG"
}

# os_field KEY: value from /etc/os-release without sourcing it
os_field() {
  awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2); gsub(/^"|"$/, "", v); print v; exit }' /etc/os-release 2>/dev/null || true
}

precheck() {
  step "1/12" "Kiểm tra máy chủ"
  local id ver pretty arch mem_kb disk_kb
  id=$(os_field ID)
  ver=$(os_field VERSION_ID)
  pretty=$(os_field PRETTY_NAME)
  pretty=${pretty:-không rõ}
  case "$id:$ver" in
    ubuntu:22.04 | ubuntu:24.04 | debian:12 | debian:13) ok "Hệ điều hành: $pretty" ;;
    *)
      if [[ $OPT_FORCE_OS -eq 1 ]]; then
        warn "Hệ điều hành $pretty chưa được kiểm thử (--force-os): tiếp tục, có thể lỗi ở bước cài Docker."
      else
        die "Hệ điều hành $pretty chưa được hỗ trợ. Dùng Ubuntu 22.04/24.04 hoặc Debian 12/13 (khuyến nghị Ubuntu 24.04). Muốn thử vẫn chạy: thêm --force-os."
      fi
      ;;
  esac
  OS_ID=$id
  case "$id" in ubuntu | debian) ;; *) OS_ID=$(os_field ID_LIKE | grep -Eo 'ubuntu|debian' | head -n 1 || true) ;; esac
  [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]] || die "Chỉ hỗ trợ hệ điều hành họ Ubuntu/Debian (dùng apt)."

  arch=$(dpkg --print-architecture 2>/dev/null || uname -m)
  case "$arch" in
    amd64 | x86_64 | arm64 | aarch64) ok "Kiến trúc: $arch" ;;
    *) die "Kiến trúc $arch không được hỗ trợ (cần amd64 hoặc arm64)." ;;
  esac

  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  MEM_KB=$mem_kb
  if ((mem_kb < 1900000)); then
    warn "RAM chỉ có $((mem_kb / 1024)) MB (khuyến nghị tối thiểu 2 GB). Script sẽ tạo swap; máy vẫn có thể chậm."
  else
    ok "RAM: $((mem_kb / 1024)) MB"
  fi

  disk_kb=$(df -Pk / | awk 'NR==2 {print $4}')
  if ((disk_kb < 10 * 1024 * 1024)); then
    die "Ổ đĩa / chỉ còn trống $((disk_kb / 1024 / 1024)) GB, cần tối thiểu 10 GB. Nâng cấp ổ đĩa hoặc dọn dẹp rồi chạy lại."
  elif ((disk_kb < 20 * 1024 * 1024)); then
    warn "Ổ đĩa / còn trống $((disk_kb / 1024 / 1024)) GB (khuyến nghị ≥ 20 GB cho nhật ký, bản sao lưu, image các phiên bản)."
  else
    ok "Ổ đĩa trống: $((disk_kb / 1024 / 1024)) GB"
  fi

  if [[ -f "$DIR/.env" ]]; then
    MODE="repair"
    ok "Đã có bản cài ở $DIR → chế độ sửa chữa / cập nhật cấu hình."
  fi
  [[ $TEST_MODE -eq 1 ]] && warn "CHẾ ĐỘ KIỂM THỬ (ADS_MCP_INSTALL_TEST=1): bỏ qua kiểm tra DNS, HTTPS dùng chứng chỉ nội bộ."
  return 0
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

base_tools() {
  step "2/12" "Cài công cụ cơ bản"
  local need=() p
  for p in curl git openssl jq ss getent; do command -v "$p" >/dev/null 2>&1 || need+=("$p"); done
  if [[ ${#need[@]} -gt 0 ]] || [[ ! -e /etc/ssl/certs/ca-certificates.crt ]]; then
    info "Đang cài: ca-certificates curl git openssl jq iproute2 (khoảng 1 phút)…"
    run "apt-get update" env DEBIAN_FRONTEND=noninteractive apt-get update -q ||
      die "apt-get update lỗi. Kiểm tra mạng / nguồn apt của máy chủ (xem $LOG)."
    run "apt-get install base" apt_install ca-certificates curl git openssl jq iproute2 ||
      die "Không cài được các gói cơ bản (xem $LOG)."
  fi
  ok "curl, git, openssl, jq đã sẵn sàng"
  if curl -fsS --max-time 15 -o /dev/null https://api.github.com 2>>"$LOG"; then
    ok "Kết nối Internet tới GitHub: được"
  else
    die "Máy chủ không kết nối được https://api.github.com. Kiểm tra mạng, DNS (/etc/resolv.conf) hoặc tường lửa chiều ra."
  fi
}

ask_token_loop() {
  local tries=0
  while true; do
    if [[ -z "$GH_TOKEN" ]]; then
      info "Token GitHub: PAT classic tích \"repo\" + \"read:packages\" (tạo ở https://github.com/settings/tokens/new)."
      ask_secret GH_TOKEN "Dán token GitHub (không hiện ra màn hình)"
    fi
    if ! valid_token_shape "$GH_TOKEN"; then
      err "Token không đúng định dạng (dán thiếu ký tự hoặc thừa dấu cách?)."
    else
      info "Đang kiểm tra token với GitHub…"
      if validate_token; then
        ok "Token hợp lệ: tài khoản ${TOKEN_LOGIN}, có quyền repo + read:packages, đọc được ${REPO}"
        if [[ -n "$TOKEN_EXPIRY_EPOCH" ]]; then
          local days=$(((TOKEN_EXPIRY_EPOCH - $(date +%s)) / 86400))
          if ((days < 30)); then
            warn "Token hết hạn ngày $(vn_date "$TOKEN_EXPIRY_EPOCH") (còn $days ngày). Nên tạo token mới hạn dài hơn; đổi sau bằng: sudo ads-mcp token"
          else
            ok "Token hết hạn ngày $(vn_date "$TOKEN_EXPIRY_EPOCH") (còn $days ngày). Đặt lịch nhắc gia hạn trước 2 tuần."
          fi
        else
          warn "Token không có ngày hết hạn. GitHub khuyến nghị luôn đặt hạn cho token."
        fi
        return 0
      fi
    fi
    GH_TOKEN=""
    tries=$((tries + 1))
    if [[ $HAVE_TTY -ne 1 || $OPT_YES -eq 1 || $tries -ge 3 ]]; then
      die "Token GitHub không dùng được (xem lý do ở trên)."
    fi
  done
}

questions() {
  step "3/12" "Thông tin cài đặt"
  local d e u s ans

  # domain
  d=$(normalize_domain "$OPT_DOMAIN")
  while true; do
    if [[ -z "$d" ]]; then
      ask ans "Tên miền chạy phần mềm (vd mcp.congty.vn)" "" "--domain"
      d=$(normalize_domain "$ans")
    fi
    if valid_domain "$d"; then break; fi
    err "Tên miền \"$d\" không hợp lệ. Ví dụ đúng: mcp.congty.vn (không có http://, không có dấu /, không dấu cách)."
    [[ $HAVE_TTY -eq 1 && $OPT_YES -eq 0 ]] || die "Tên miền không hợp lệ: $d"
    d=""
  done
  DOMAIN=$d

  # HTTPS mode
  s=$OPT_SSL
  if [[ -z "$s" ]]; then
    if [[ $OPT_YES -eq 1 || $HAVE_TTY -ne 1 ]]; then
      s=auto
    else
      info "Cách đưa web ra Internet (HTTPS):"
      info "  1 = Tự động (khuyến nghị): bản ghi A của tên miền trỏ về IP VPS, mở cổng 80/443, chứng chỉ Let's Encrypt."
      info "  2 = Cloudflare Tunnel: VPS không cần mở cổng; tên miền phải dùng DNS của Cloudflare, cần token tunnel."
      while true; do
        ask ans "Chọn 1 hoặc 2" "1"
        case "$ans" in 1) s=auto; break ;; 2) s=tunnel; break ;; *) err "Chỉ chọn 1 hoặc 2." ;; esac
      done
    fi
  fi
  SSL_MODE=$s

  # email
  e=$OPT_EMAIL
  while true; do
    if [[ -z "$e" ]]; then
      if [[ "$SSL_MODE" == "auto" ]]; then
        ask e "Email nhận thông báo chứng chỉ (Let's Encrypt)" "" "--email"
      else
        [[ $OPT_YES -eq 1 || $HAVE_TTY -ne 1 ]] && break
        ask e "Email liên hệ (không bắt buộc với Cloudflare Tunnel, Enter để bỏ qua)" "-"
        [[ "$e" == "-" ]] && { e=""; break; }
      fi
    fi
    if valid_email "$e"; then break; fi
    err "Email \"$e\" không hợp lệ."
    [[ $HAVE_TTY -eq 1 && $OPT_YES -eq 0 ]] || die "Email không hợp lệ: $e"
    e=""
  done
  EMAIL=$e

  # GitHub user
  u=$OPT_USER
  if [[ "$MODE" == "repair" && -z "$u" && -r "$CONF" ]]; then u=$(env_get GITHUB_USER "$CONF"); fi
  while true; do
    [[ -n "$u" ]] || ask u "Tên tài khoản GitHub đã được Nextgency cấp quyền" "" "--github-user"
    if valid_github_user "$u"; then break; fi
    err "Tên tài khoản GitHub \"$u\" không hợp lệ."
    [[ $HAVE_TTY -eq 1 && $OPT_YES -eq 0 ]] || die "Tên tài khoản GitHub không hợp lệ: $u"
    u=""
  done
  GH_USER=$u

  # GitHub token
  GH_TOKEN=${ENV_GITHUB_TOKEN//[[:space:]]/}
  ask_token_loop

  # Tunnel token
  if [[ "$SSL_MODE" == "tunnel" ]]; then
    TUNNEL_TOKEN_VALUE=${ENV_TUNNEL_TOKEN//[[:space:]]/}
    while ! valid_tunnel_token "$TUNNEL_TOKEN_VALUE"; do
      [[ -z "$TUNNEL_TOKEN_VALUE" ]] || err "Token Cloudflare Tunnel không đúng định dạng (chuỗi dài bắt đầu bằng eyJ, ngay sau --token)."
      [[ $HAVE_TTY -eq 1 && ($OPT_YES -eq 0 || -z "$TUNNEL_TOKEN_VALUE") ]] || die "Thiếu hoặc sai token Cloudflare Tunnel (biến ADS_MCP_TUNNEL_TOKEN)."
      info "Lấy token: dash.cloudflare.com → Networking → Tunnels → Create a tunnel → chọn Docker → sao chép chuỗi eyJ… sau --token."
      info "Route của tunnel: Published application, tên miền = $DOMAIN, Service URL = http://caddy:80 (docs/deploy-vps.md 10b.3)."
      ask_secret TUNNEL_TOKEN_VALUE "Dán token Cloudflare Tunnel (không hiện ra màn hình)"
    done
    ok "Đã nhận token Cloudflare Tunnel"
  fi

  # firewall / updater
  if [[ -n "$OPT_FIREWALL" ]]; then FIREWALL=$OPT_FIREWALL; elif ask_yn "Bật tường lửa UFW (chỉ mở SSH$([[ "$SSL_MODE" == "auto" ]] && printf ', 80, 443'))?" Y; then FIREWALL=1; else FIREWALL=0; fi
  if [[ -n "$OPT_UPDATER" ]]; then UPDATER=$OPT_UPDATER; elif ask_yn "Bật cập nhật tự động (admin bấm \"Cập nhật\" trong web)?" Y; then UPDATER=1; else UPDATER=0; fi

  # release
  info "Đang lấy thông tin bản phát hành…"
  resolve_release ""
  LATEST_VER=$RELEASE_VER
  if [[ -n "$OPT_VERSION" ]]; then
    resolve_release "$OPT_VERSION"
    APP_VER=$RELEASE_VER
  else
    APP_VER=$LATEST_VER
  fi
  ok "Phiên bản sẽ cài: $APP_VER (mới nhất: $LATEST_VER)"

  # summary
  say ""
  say "   ${C_BLD}Tóm tắt${C_RST}"
  info "Tên miền:           $DOMAIN"
  if [[ "$SSL_MODE" == "auto" ]]; then info "HTTPS:              Tự động (Caddy + Let's Encrypt), email $EMAIL"; else info "HTTPS:              Cloudflare Tunnel${EMAIL:+, email $EMAIL}"; fi
  # masked token on the terminal only (not in the log)
  printf '   Tài khoản GitHub:   %s (token: %s…%s)\n' "$GH_USER" "${GH_TOKEN:0:4}" "${GH_TOKEN: -4}"
  info "Phiên bản:          $APP_VER"
  info "Thư mục cài:        $DIR"
  info "Tường lửa UFW:      $([[ $FIREWALL -eq 1 ]] && printf 'Bật' || printf 'Không')"
  info "Cập nhật tự động:   $([[ $UPDATER -eq 1 ]] && printf 'Bật' || printf 'Không')"
  ask_yn "Cài với các thông tin trên?" Y || die "Đã huỷ theo yêu cầu. Chưa thay đổi gì trên máy chủ (ngoài các gói công cụ cơ bản)."
}

public_ipv4() {
  local u ip
  for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -4fsS --max-time 8 "$u" 2>/dev/null | tr -d '[:space:]' || true)
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && { printf '%s' "$ip"; return 0; }
  done
  return 1
}

dns_check() {
  step "4/12" "Kiểm tra tên miền và cổng"
  if [[ "$SSL_MODE" == "tunnel" ]]; then
    ok "Cloudflare Tunnel: không cần bản ghi A, không cần mở cổng 80/443."
    info "Nhắc lại: route của tunnel trỏ tới http://caddy:80, tên miền $DOMAIN, không đặt HTTP Host Header."
    return 0
  fi
  if [[ $TEST_MODE -eq 1 ]]; then
    warn "Chế độ kiểm thử: bỏ qua so khớp IP công khai với bản ghi DNS."
  elif [[ $OPT_SKIP_DNS -eq 1 ]]; then
    warn "Bỏ qua kiểm tra DNS (--skip-dns-check): Caddy chỉ cấp được chứng chỉ khi bản ghi A trỏ đúng IP máy chủ."
  else
    local my_ip a_records v6 choice
    my_ip=$(public_ipv4 || true)
    [[ -n "$my_ip" ]] || warn "Không xác định được IPv4 công khai của máy chủ (dịch vụ dò IP không phản hồi)."
    while true; do
      a_records=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
      a_records=${a_records% }
      if [[ -n "$my_ip" && " $a_records " == *" $my_ip "* ]]; then
        ok "Bản ghi A của $DOMAIN trỏ đúng IP máy chủ ($my_ip)."
        break
      fi
      local cf=0 ip
      for ip in $a_records; do is_cloudflare_ip "$ip" && cf=1; done
      if [[ $cf -eq 1 ]]; then
        err "$DOMAIN đang trỏ về IP của Cloudflare ($a_records): đám mây cam (Proxied) đang bật."
        info "Cách sửa: trong Cloudflare → DNS → bản ghi $DOMAIN → bấm vào đám mây cam để thành xám (DNS only)."
        info "Hoặc chạy lại và chọn cách 2 (Cloudflare Tunnel). Cloudflare proxy (mây cam) cần cấu hình tay: docs/deploy-vps.md mục 9."
      elif [[ -z "$a_records" ]]; then
        err "Chưa có bản ghi A cho $DOMAIN (hoặc DNS chưa cập nhật)."
        info "Tạo bản ghi A: tên $DOMAIN → ${my_ip:-<IP VPS>} ở nơi quản lý tên miền, đợi vài phút."
      else
        err "$DOMAIN trỏ về $a_records, nhưng IP máy chủ này là ${my_ip:-không rõ}."
        info "Sửa bản ghi A của $DOMAIN thành ${my_ip:-<IP VPS>} rồi đợi vài phút."
      fi
      if [[ $HAVE_TTY -ne 1 || $OPT_YES -eq 1 ]]; then
        die "DNS chưa đúng. Sửa DNS rồi chạy lại (hoặc thêm --skip-dns-check nếu chắc chắn DNS đúng)."
      fi
      info "  1 = Đã sửa DNS, kiểm tra lại   2 = Vẫn tiếp tục (chứng chỉ sẽ lỗi tới khi DNS đúng)   3 = Thoát"
      ask choice "Chọn" "1"
      case "$choice" in
        1) info "Đang kiểm tra lại…" ;;
        2) warn "Tiếp tục khi DNS chưa đúng."; break ;;
        *) die "Đã thoát. Sửa DNS rồi chạy lại script." ;;
      esac
    done
    v6=$(getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '{print $1}' | grep -v '^::ffff:' | sort -u | tr '\n' ' ' || true)
    if [[ -n "${v6// /}" ]]; then
      warn "$DOMAIN có bản ghi AAAA (IPv6: $v6). Nên xoá: khách IPv6 sẽ bị gộp chung một IP (docs/deploy-vps.md mục 2)."
    fi
  fi

  # ports 80/443 must be free on a fresh install
  if [[ "$MODE" == "install" ]]; then
    local busy procs
    busy=$(ss -Hltnp '( sport = :80 or sport = :443 )' 2>/dev/null || true)
    if [[ -n "$busy" ]]; then
      procs=$(grep -o 'users:(("[^"]*"' <<<"$busy" | sed 's/users:(("//; s/"$//' | sort -u | tr '\n' ' ' || true)
      err "Cổng 80/443 đang bị chương trình khác dùng: ${procs:-không rõ}."
      info "Ads MCP (Caddy) cần 2 cổng này để cấp HTTPS. Cách xử lý:"
      info "  - Máy chỉ dành cho Ads MCP: gỡ hoặc tắt chương trình đó, vd: systemctl disable --now nginx (hoặc apache2)."
      info "  - Máy đang chạy web khác bằng Nginx: cài tay theo docs/deploy-vps.md mục 10 (phương án C)."
      info "  - Hoặc chạy lại và chọn Cloudflare Tunnel (--ssl tunnel): không cần cổng 80/443."
      die "Cổng 80/443 đang bận."
    fi
    ok "Cổng 80 và 443 đang trống."
  fi
}

swap_mb() { awk '/^SwapTotal:/ {print int($2 / 1024)}' /proc/meminfo; }

setup_swap() {
  step "5/12" "Bộ nhớ swap"
  local active
  active=$(swapon --show --noheadings 2>/dev/null || true)
  if [[ -n "$active" ]]; then
    SWAP_STATE="đã có sẵn ($(swap_mb) MB)"
    ok "Swap: $SWAP_STATE"
    return 0
  fi
  if ((MEM_KB > 2621440)); then
    SWAP_STATE="không cần (RAM $((MEM_KB / 1024)) MB)"
    ok "Swap: $SWAP_STATE"
    return 0
  fi
  info "RAM ≤ 2,5 GB: tạo /swapfile 2 GB…"
  if [[ ! -f /swapfile ]]; then
    if ! run "fallocate swap" fallocate -l 2G /swapfile; then
      rm -f /swapfile
      run "dd swap" dd if=/dev/zero of=/swapfile bs=1M count=2048 || { SWAP_STATE="tạo thất bại"; warn "Không tạo được swap (xem $LOG)."; return 0; }
    fi
    chmod 600 /swapfile
    run "mkswap" mkswap /swapfile || { SWAP_STATE="tạo thất bại"; warn "mkswap lỗi (xem $LOG)."; return 0; }
  fi
  if run "swapon" swapon /swapfile; then
    grep -qE '^/swapfile[[:space:]]' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
    SWAP_STATE="đã tạo /swapfile 2 GB"
    ok "Swap: $SWAP_STATE"
  else
    SWAP_STATE="không bật được (máy ảo không cho phép swap?)"
    warn "Swap: $SWAP_STATE"
  fi
}

ssh_ports() {
  local ports="22" p
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    p=$(awk '{print $4}' <<<"$SSH_CONNECTION")
    [[ "$p" =~ ^[0-9]+$ ]] && ports+=" $p"
  fi
  if command -v sshd >/dev/null 2>&1; then
    for p in $(sshd -T 2>/dev/null | awk '$1=="port" {print $2}'); do [[ "$p" =~ ^[0-9]+$ ]] && ports+=" $p"; done
  fi
  for p in $(ss -Hltnp 2>/dev/null | grep '"sshd"' | awk '{print $4}' | sed 's/.*://' || true); do [[ "$p" =~ ^[0-9]+$ ]] && ports+=" $p"; done
  tr ' ' '\n' <<<"$ports" | sort -un | tr '\n' ' '
}

# ufw_apply "<ssh ports>": SSH ports are allowed BEFORE the firewall is enabled. sshd config is never touched.
ufw_apply() {
  local p
  run "ufw default deny incoming" ufw default deny incoming || return 1
  run "ufw default allow outgoing" ufw default allow outgoing || return 1
  for p in $1; do run "ufw allow $p/tcp" ufw allow "$p/tcp" || return 1; done
  if [[ "$SSL_MODE" == "auto" ]]; then
    run "ufw allow 80/tcp" ufw allow 80/tcp || return 1
    run "ufw allow 443/tcp" ufw allow 443/tcp || return 1
    run "ufw allow 443/udp" ufw allow 443/udp || return 1
  fi
  run "ufw enable" ufw --force enable
}

setup_firewall() {
  step "6/12" "Tường lửa"
  if [[ $FIREWALL -ne 1 ]]; then
    FIREWALL_STATE="không bật (theo lựa chọn)"
    warn "Bỏ qua UFW. Nhớ mở đúng cổng ở tường lửa của nhà cung cấp VPS."
    return 0
  fi
  if ! command -v ufw >/dev/null 2>&1; then
    info "Đang cài ufw…"
    run "apt-get install ufw" apt_install ufw || { FIREWALL_STATE="cài ufw thất bại"; warn "Không cài được ufw (xem $LOG). Bỏ qua tường lửa."; return 0; }
  fi
  local ports
  ports=$(ssh_ports)
  if ! ufw_apply "$ports"; then
    FIREWALL_STATE="bật thất bại"
    warn "Không bật được UFW (xem $LOG). Bỏ qua tường lửa, tiếp tục cài."
    return 0
  fi
  if [[ "$SSL_MODE" == "auto" ]]; then FIREWALL_STATE="UFW bật: SSH (${ports% }), 80/tcp, 443/tcp, 443/udp"; else FIREWALL_STATE="UFW bật: chỉ SSH (${ports% })"; fi
  ok "$FIREWALL_STATE"
  info "Nhớ mở cùng các cổng đó ở tường lửa của nhà cung cấp VPS (Security Group / Cloud Firewall) nếu có."
}

start_docker_daemon() {
  if docker info >/dev/null 2>&1; then return 0; fi
  if [[ -d /run/systemd/system ]]; then
    run "systemctl enable --now containerd docker" systemctl enable --now containerd.service docker.service || true
  else
    # no systemd as PID 1 (container / WSL): start dockerd in the background
    info "Không có systemd: khởi động dockerd chạy nền."
    nohup setsid dockerd >>/var/log/ads-mcp-dockerd.log 2>&1 </dev/null &
  fi
  local i
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "Docker không khởi động được. Xem: journalctl -u docker (hoặc /var/log/ads-mcp-dockerd.log)."
}

install_docker() {
  step "7/12" "Docker Engine"
  if docker compose version >/dev/null 2>&1; then
    ok "Đã có Docker + Compose: $(docker --version 2>/dev/null | sed 's/,.*//'), $(docker compose version --short 2>/dev/null)"
    start_docker_daemon
    return 0
  fi
  local conflicts=() p codename url
  for p in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    dpkg -s "$p" >/dev/null 2>&1 && conflicts+=("$p")
  done
  if [[ ${#conflicts[@]} -gt 0 ]]; then
    warn "Máy có gói Docker của hệ điều hành: ${conflicts[*]}. Cần gỡ để cài Docker chính thức (container đang chạy sẽ dừng)."
    ask_yn "Gỡ các gói trên và cài Docker chính thức?" Y || die "Đã huỷ. Gỡ các gói đó bằng tay rồi chạy lại."
    run "apt-get remove conflicts" env DEBIAN_FRONTEND=noninteractive apt-get remove -y "${conflicts[@]}" || die "Không gỡ được ${conflicts[*]} (xem $LOG)."
  fi
  info "Đang cài Docker từ kho apt chính thức của Docker (2-4 phút)…"
  if [[ "$OS_ID" == "ubuntu" ]]; then
    url="https://download.docker.com/linux/ubuntu"
    codename=$(os_field UBUNTU_CODENAME)
    [[ -n "$codename" ]] || codename=$(os_field VERSION_CODENAME)
  else
    url="https://download.docker.com/linux/debian"
    codename=$(os_field VERSION_CODENAME)
  fi
  [[ "$codename" =~ ^[a-z]+$ ]] || die "Không xác định được tên phiên bản hệ điều hành (VERSION_CODENAME) trong /etc/os-release."
  install -m 0755 -d /etc/apt/keyrings
  run "download docker gpg" curl -fsSL "$url/gpg" -o /etc/apt/keyrings/docker.asc || die "Không tải được khoá GPG của Docker ($url/gpg)."
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: $url
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  run "apt-get update (docker)" env DEBIAN_FRONTEND=noninteractive apt-get update -q || die "apt-get update lỗi sau khi thêm kho Docker (xem $LOG)."
  run "apt-get install docker" apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin ||
    die "Cài Docker thất bại (xem $LOG)."
  start_docker_daemon
  docker compose version >/dev/null 2>&1 || die "Đã cài Docker nhưng lệnh docker compose không chạy (xem $LOG)."
  ok "Đã cài $(docker --version | sed 's/,.*//'), Compose $(docker compose version --short)"
}

# git with a temporary askpass helper: the token travels only through the environment of the git process.
git_auth() {
  local helper="$TMPD/askpass.sh"
  if [[ ! -x "$helper" ]]; then
    cat >"$helper" <<'EOF'
#!/bin/sh
case "$1" in
  Username*) printf '%s\n' "$ADS_MCP_GIT_USER" ;;
  *) printf '%s\n' "$ADS_MCP_GIT_TOKEN" ;;
esac
EOF
    chmod 700 "$helper"
  fi
  ADS_MCP_GIT_USER="$GH_USER" ADS_MCP_GIT_TOKEN="$GH_TOKEN" GIT_ASKPASS="$helper" GIT_TERMINAL_PROMPT=0 \
    git -c credential.helper= -c core.askPass="$helper" "$@"
}

fetch_source() {
  step "8/12" "Tải mã nguồn (cấu hình triển khai) v$APP_VER"
  if [[ -d "$DIR/.git" ]]; then
    local origin
    origin=$(git -C "$DIR" config --get remote.origin.url || true)
    [[ "${origin,,}" == *"schhung1822/nextgency-mcp-ads"* ]] || die "$DIR đã là một repo git khác ($origin). Dùng --dir để chọn thư mục khác."
    info "Thư mục $DIR đã có mã nguồn (lần cài trước dừng giữa chừng): lấy đúng tag v$APP_VER."
    run "git fetch tag" git_auth -C "$DIR" fetch -q --depth 1 origin "refs/tags/v$APP_VER:refs/tags/v$APP_VER" || die "Không tải được tag v$APP_VER (xem $LOG)."
    run "git checkout tag" git -C "$DIR" -c advice.detachedHead=false checkout -q --force "v$APP_VER" || die "Không chuyển được sang v$APP_VER (xem $LOG)."
  else
    if [[ -e "$DIR" ]] && [[ -n "$(ls -A "$DIR" 2>/dev/null)" ]]; then
      die "Thư mục $DIR đã có dữ liệu khác. Dùng --dir để chọn thư mục trống, hoặc chuyển dữ liệu đi rồi chạy lại."
    fi
    mkdir -p "$DIR"
    run "git clone v$APP_VER" git_auth -c advice.detachedHead=false clone -q --depth 1 --branch "v$APP_VER" "$REPO_URL" "$DIR" ||
      die "git clone thất bại (xem $LOG). Kiểm tra token còn quyền đọc ${REPO}."
  fi
  local url
  url=$(git -C "$DIR" config --get remote.origin.url || true)
  [[ "$url" != *@* ]] || die "remote.origin.url có chứa thông tin đăng nhập - dừng để tránh lộ token."
  [[ -f "$DIR/docker-compose.yml" && -f "$DIR/scripts/gen-secrets.sh" ]] || die "Mã nguồn tải về thiếu docker-compose.yml / scripts/gen-secrets.sh."
  mkdir -p "$DIR/backups"
  chmod 700 "$DIR/backups"
  ok "Mã nguồn v$APP_VER ở $DIR (commit $(git -C "$DIR" rev-parse --short HEAD))"
}

ghcr_login() {
  step "9/12" "Đăng nhập kho image GHCR"
  export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"
  mkdir -p "$DOCKER_CONFIG_DIR"
  chmod 700 "$DOCKER_CONFIG_DIR"
  local cfg="$DOCKER_CONFIG_DIR/config.json" attempt
  for attempt in 1 2; do
    if ! printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin >>"$LOG" 2>&1; then
      die "docker login ghcr.io thất bại (xem $LOG). Token cần quyền read:packages và tài khoản phải có quyền Read trên ${REPO}."
    fi
    if [[ -f "$cfg" ]] && jq -e 'has("credsStore") or has("credHelpers")' "$cfg" >/dev/null 2>&1; then
      [[ $attempt -eq 2 ]] && die "$cfg vẫn dùng credential helper; updater sẽ không kéo được image. Xem docs/deploy-vps.md 6.2."
      warn "$cfg dùng credential helper (updater không đọc được): bỏ cấu hình đó và đăng nhập lại."
      jq 'del(.credsStore, .credHelpers)' "$cfg" >"$cfg.tmp" && chmod 600 "$cfg.tmp" && mv -f "$cfg.tmp" "$cfg"
      docker logout ghcr.io >>"$LOG" 2>&1 || true
      continue
    fi
    break
  done
  chmod 600 "$cfg"
  grep -q '"ghcr.io"' "$cfg" || die "Không thấy thông tin đăng nhập ghcr.io trong $cfg."
  ok "Đã đăng nhập ghcr.io bằng tài khoản $GH_USER (lưu ở $cfg, updater dùng chung)."
}

write_env() {
  step "10/12" "Tạo file cấu hình .env"
  local args=(--domain "$DOMAIN" --ssl "$SSL_MODE" --app-version "$APP_VER")
  [[ -n "$EMAIL" ]] && args+=(--email "$EMAIL")
  [[ $UPDATER -eq 1 ]] || args+=(--no-updater)
  # openssl branch of gen-secrets.sh (same output as gen-env.mjs, avoids pulling node:24-slim just for this)
  (cd "$DIR" && run "gen-secrets.sh ${args[*]}" env HOST_PROJECT_DIR="$DIR" GEN_SECRETS_FALLBACK=1 sh scripts/gen-secrets.sh "${args[@]}") ||
    die "Tạo .env thất bại (xem $LOG)."
  chmod 600 "$DIR/.env"
  env_set UPDATE_REPO "$REPO"
  env_set UPDATE_GITHUB_TOKEN "$GH_TOKEN"
  [[ "$SSL_MODE" == "tunnel" ]] && env_set TUNNEL_TOKEN "$TUNNEL_TOKEN_VALUE"
  [[ "$(env_get APP_VERSION)" == "$APP_VER" ]] || die ".env có APP_VERSION khác $APP_VER."
  [[ "$(env_get HOST_PROJECT_DIR)" == "$DIR" ]] || env_set HOST_PROJECT_DIR "$DIR"
  if [[ $UPDATER -eq 1 ]]; then [[ "$(env_get COMPOSE_PROFILES)" == "updater" ]] || env_set COMPOSE_PROFILES updater; fi
  [[ -n "$(env_get SETUP_TOKEN)" && -n "$(env_get ENCRYPTION_KEYS)" ]] || die ".env thiếu khoá bí mật sau khi tạo."
  ok "Đã tạo $DIR/.env (quyền 600) với khoá bí mật ngẫu nhiên, token GitHub cho kiểm tra bản mới$([[ "$SSL_MODE" == "tunnel" ]] && printf ', token tunnel')."
  warn "Sao lưu file .env ngay vào nơi an toàn KHÁC máy chủ: mất file = mất toàn bộ token quảng cáo đã lưu."
}

dc() { (cd "$DIR" && docker compose "$@"); }

explain_pull_error() {
  if tail -n 60 "$LOG" | grep -qiE 'denied|unauthorized'; then
    err "GHCR từ chối (denied/unauthorized): token hết hạn/bị thu hồi, thiếu read:packages, tài khoản mất quyền Read, hoặc tổ chức bật SSO chưa Authorize token."
    info "Sửa token rồi chạy: sudo ads-mcp token  (docs/deploy-vps.md 13.2)"
  elif tail -n 60 "$LOG" | grep -qiE 'manifest unknown|not found'; then
    err "Không có image cho phiên bản $APP_VER (manifest unknown). Bản phát hành có thể đang được build: đợi vài phút rồi chạy lại."
  elif tail -n 60 "$LOG" | grep -qi 'no matching manifest'; then
    err "Image không có bản cho kiến trúc máy này. Dùng VPS amd64 hoặc arm64."
  elif tail -n 60 "$LOG" | grep -qi 'toomanyrequests'; then
    err "Docker Hub giới hạn lượt tải (toomanyrequests). Đợi khoảng 1 giờ rồi chạy lại."
  fi
}

compose_json() { dc ps -a --format json 2>/dev/null | jq -s 'flatten' 2>/dev/null || printf '[]'; }
svc_field() { jq -r --arg s "$2" --arg f "$3" '[.[] | select(.Service==$s)][0][$f] // empty' <<<"$1"; }

wait_stack() {
  local deadline=$(($(date +%s) + 300)) json mstate mcode wh
  while true; do
    json=$(compose_json)
    mstate=$(svc_field "$json" migrate State)
    mcode=$(svc_field "$json" migrate ExitCode)
    wh=$(svc_field "$json" web Health)
    if [[ "$mstate" == "exited" && "$mcode" != "0" && -n "$mcode" ]]; then
      dc logs --no-color --tail=40 migrate web >>"$LOG" 2>&1 || true
      show_log_tail 40
      die "Bước migrate (tạo bảng dữ liệu) lỗi, mã $mcode. Xem log ở trên; docs/deploy-vps.md 13.3."
    fi
    if [[ "$wh" == "healthy" ]]; then return 0; fi
    if (($(date +%s) > deadline)); then
      dc logs --no-color --tail=40 migrate web >>"$LOG" 2>&1 || true
      show_log_tail 40
      die "Web chưa sẵn sàng sau 5 phút (trạng thái: migrate=${mstate:-?}, web=${wh:-?}). Xem log ở trên; docs/deploy-vps.md 13.3."
    fi
    sleep 5
  done
}

check_https() {
  if [[ "$SSL_MODE" == "tunnel" ]]; then
    local body ch
    body=$(dc exec -T caddy wget -qO- --header "Host: $DOMAIN" http://127.0.0.1/api/health 2>>"$LOG" || true)
    if [[ -n "$body" ]]; then ok "caddy → web trong máy chủ: OK"; else warn "caddy chưa chuyển được request tới web (xem: sudo ads-mcp logs caddy)."; fi
    local i
    for i in $(seq 1 12); do
      ch=$(svc_field "$(compose_json)" cloudflared Health)
      [[ "$ch" == "healthy" ]] && break
      sleep 5
    done
    if [[ "$ch" == "healthy" ]]; then
      HTTPS_STATE="Cloudflare Tunnel đã kết nối (https://$DOMAIN)"
      ok "$HTTPS_STATE"
    else
      HTTPS_STATE="chưa xác nhận - cloudflared chưa kết nối được Cloudflare"
      warn "cloudflared chưa kết nối (trạng thái: ${ch:-không rõ}). Kiểm tra token tunnel, route http://caddy:80; xem: sudo ads-mcp logs cloudflared"
      dc logs --no-color --tail=40 cloudflared >>"$LOG" 2>&1 || true
    fi
    return 0
  fi
  info "Đang đợi Caddy xin chứng chỉ HTTPS cho $DOMAIN (tối đa 3 phút)…"
  local deadline=$(($(date +%s) + 180))
  local -a curl_args=(-fsS --max-time 10 -o /dev/null)
  [[ $TEST_MODE -eq 1 ]] && curl_args+=(-k --resolve "$DOMAIN:443:127.0.0.1")
  while true; do
    if curl "${curl_args[@]}" "https://$DOMAIN/api/health" 2>>"$LOG"; then
      if [[ $TEST_MODE -eq 1 ]]; then HTTPS_STATE="hoạt động (chứng chỉ nội bộ - chế độ kiểm thử)"; else HTTPS_STATE="hoạt động (Let's Encrypt)"; fi
      ok "https://$DOMAIN: $HTTPS_STATE"
      return 0
    fi
    if (($(date +%s) > deadline)); then break; fi
    sleep 6
  done
  HTTPS_STATE="chưa xác nhận"
  dc logs --no-color --tail=40 caddy >>"$LOG" 2>&1 || true
  warn "Chưa truy cập được https://$DOMAIN sau 3 phút. Hệ thống vẫn chạy; Caddy sẽ tự thử lại."
  info "Nguyên nhân thường gặp: bản ghi A chưa trỏ đúng IP, cổng 80/443 bị chặn ở tường lửa nhà cung cấp, Let's Encrypt giới hạn số lần."
  info "Xem log: sudo ads-mcp logs caddy  (tìm \"certificate obtained\" hoặc \"challenge failed\")."
}

start_stack() {
  step "11/12" "Tải image và khởi chạy"
  info "Đang tải image (vài trăm MB, 2-5 phút tuỳ mạng)…"
  if ! run "docker compose pull" dc pull -q; then
    warn "Tải image lỗi, thử lại lần nữa…"
    if ! run "docker compose pull (retry)" dc pull -q; then
      explain_pull_error
      show_log_tail 15
      die "Không tải được image."
    fi
  fi
  ok "Đã tải image"
  run "docker compose up" dc up -d --no-build || { show_log_tail 25; die "docker compose up thất bại."; }
  info "Đang đợi database, migrate và web khởi động (tối đa 5 phút)…"
  wait_stack
  ok "migrate xong, web healthy"
  check_https
}

post_checks() {
  step "12/12" "Kiểm tra sau cài đặt"
  local json st
  json=$(compose_json)
  if [[ "$(env_get COMPOSE_PROFILES)" == *updater* ]]; then
    st=$(svc_field "$json" updater State)
    if [[ "$st" == "running" ]]; then
      UPDATER_STATE="Bật - đã thấy bản mới nhất v$LATEST_VER"
      ok "Updater đang chạy; kiểm tra bản mới với GitHub: OK (mới nhất v$LATEST_VER)"
    else
      UPDATER_STATE="Bật nhưng updater chưa chạy (${st:-không có})"
      warn "Updater chưa chạy (${st:-không có container}). Xem: sudo ads-mcp logs updater"
    fi
  else
    UPDATER_STATE="Tắt - cập nhật tay (docs/deploy-vps.md 11.2); bản mới nhất v$LATEST_VER"
    info "Cập nhật tự động: tắt"
  fi
  for st in worker backup; do
    if [[ "$(svc_field "$json" "$st" State)" == "running" ]]; then ok "$st đang chạy"; else warn "$st chưa chạy (xem: sudo ads-mcp logs $st)"; fi
  done
  USER_COUNT=$(dc exec -T db psql -U adsmcp -d adsmcp -Atc 'select count(*) from "user"' 2>>"$LOG" | tr -d '[:space:]' || true)
  [[ "$USER_COUNT" =~ ^[0-9]+$ ]] || USER_COUNT="?"
  if [[ "$USER_COUNT" == "0" ]]; then info "Chưa có tài khoản nào: dùng mã cài đặt ở màn hình cuối để tạo admin."; else ok "Số tài khoản trong hệ thống: $USER_COUNT"; fi

  # ads-mcp helper: repo copy first (updates with `ads-mcp update-config`), else the copy next to this installer
  local src=""
  if [[ -f "$DIR/scripts/ads-mcp" ]]; then
    src="$DIR/scripts/ads-mcp"
  elif [[ -n "${BASH_SOURCE[0]:-}" && -f "$(dirname "${BASH_SOURCE[0]}")/ads-mcp" ]]; then
    src="$(dirname "${BASH_SOURCE[0]}")/ads-mcp"
  elif fetch_helper_from_main; then
    src="$TMPD/ads-mcp"
  elif fetch_helper_public; then
    src="$TMPD/ads-mcp"
  fi
  if [[ -n "$src" ]]; then
    install -m 0755 "$src" "$HELPER_BIN"
    ok "Đã cài lệnh ads-mcp ($HELPER_BIN)"
  else
    warn "Bản v$APP_VER chưa kèm lệnh ads-mcp (có từ bản phát hành sau). Dùng docker compose trong $DIR."
  fi
  (
    umask 022
    printf '# Ads MCP by: Nextgency - written by install-ads-mcp.sh (no secrets here)\nADS_MCP_DIR=%s\nGITHUB_USER=%s\nINSTALLER_VERSION=%s\n' \
      "$DIR" "$GH_USER" "$INSTALLER_VERSION" >"$CONF"
  )
}

# fetch_helper_from_main: releases older than the helper do not contain scripts/ads-mcp - download it from the default
# branch with the same token (raw content), check it is a bash script that parses, keep it in $TMPD/ads-mcp.
fetch_helper_from_main() {
  [[ -n "$GH_TOKEN" ]] || return 1
  gh_api GET "/repos/$REPO/contents/scripts/ads-mcp?ref=main" "application/vnd.github.raw+json"
  [[ "$GH_STATUS" == "200" ]] || return 1
  head -n 1 "$TMPD/b" | grep -q '^#!/usr/bin/env bash' || return 1
  bash -n "$TMPD/b" 2>>"$LOG" || return 1
  cp "$TMPD/b" "$TMPD/ads-mcp"
}

# fetch_helper_public: last resort - the public installer repository publishes the same helper next to this script
# (no token needed). Same checks as above.
fetch_helper_public() {
  curl -fsSL --max-time 25 -A "ads-mcp-installer" "$INSTALL_REPO_RAW/ads-mcp" -o "$TMPD/ads-mcp.pub" 2>>"$LOG" || return 1
  head -n 1 "$TMPD/ads-mcp.pub" | grep -q '^#!/usr/bin/env bash' || return 1
  bash -n "$TMPD/ads-mcp.pub" 2>>"$LOG" || return 1
  mv "$TMPD/ads-mcp.pub" "$TMPD/ads-mcp"
}

# ------------------------------------------------------------------------------------------------------------------
# Repair mode (existing <dir>/.env): never regenerates secrets
# ------------------------------------------------------------------------------------------------------------------
repair() {
  step "3/12" "Bản cài hiện có"
  local cur_ver cur_tls cur_profiles caddy_changed=0 old_head=""
  DOMAIN=$(env_get APP_DOMAIN)
  cur_ver=$(env_get APP_VERSION)
  cur_tls=$(env_get CADDY_TLS)
  cur_profiles=$(env_get COMPOSE_PROFILES)
  EMAIL=$(env_get ACME_EMAIL)
  if [[ "$cur_tls" == "tunnel" ]]; then SSL_MODE=tunnel; else SSL_MODE=auto; fi
  info "Thư mục:     $DIR"
  info "Tên miền:    ${DOMAIN:-?}"
  info "Phiên bản:   ${cur_ver:-?}"
  local https_txt="Tự động (Caddy)"
  [[ "$SSL_MODE" == "tunnel" ]] && https_txt="Cloudflare Tunnel"
  [[ -n "$cur_tls" && "$cur_tls" != "auto" && "$cur_tls" != "tunnel" ]] && https_txt="$cur_tls (cấu hình tay)"
  info "HTTPS:       $https_txt"
  info "Chế độ sửa chữa: KHÔNG tạo lại khoá bí mật, không đổi dữ liệu. Chỉ làm mới token GitHub (nếu nhập token mới),"
  info "đăng nhập GHCR, bổ sung biến cập nhật trong .env, cài lại lệnh ads-mcp, rồi docker compose up -d."
  ask_yn "Tiếp tục sửa chữa bản cài này?" Y || die "Đã huỷ. Không thay đổi gì."

  GH_USER=$OPT_USER
  [[ -z "$GH_USER" && -r "$CONF" ]] && GH_USER=$(env_get GITHUB_USER "$CONF")
  if [[ -n "$ENV_GITHUB_TOKEN" ]]; then
    GH_TOKEN=${ENV_GITHUB_TOKEN//[[:space:]]/}
  elif [[ $HAVE_TTY -eq 1 && $OPT_YES -eq 0 ]]; then
    ask_secret GH_TOKEN "Dán token GitHub mới (Enter để giữ token đang dùng trong .env)"
  fi
  if [[ -z "$GH_TOKEN" ]]; then
    GH_TOKEN=$(env_get UPDATE_GITHUB_TOKEN)
    [[ -n "$GH_TOKEN" ]] || die "Không có token GitHub trong .env (UPDATE_GITHUB_TOKEN). Chạy lại và dán token, hoặc đặt ADS_MCP_GITHUB_TOKEN."
  fi
  if [[ -z "$GH_USER" ]]; then
    ask GH_USER "Tên tài khoản GitHub đã được Nextgency cấp quyền" "" "--github-user"
  fi
  valid_github_user "$GH_USER" || die "Tên tài khoản GitHub không hợp lệ: $GH_USER"
  ask_token_loop

  resolve_release ""
  LATEST_VER=$RELEASE_VER
  APP_VER=$cur_ver
  if [[ -n "$OPT_VERSION" && "$OPT_VERSION" != "$cur_ver" ]]; then
    resolve_release "$OPT_VERSION"
    APP_VER=$RELEASE_VER
    warn "Đổi phiên bản: $cur_ver → $APP_VER (--version)."
  fi
  valid_semver "$APP_VER" || die "APP_VERSION trong .env không hợp lệ (\"$APP_VER\"). Chạy lại với --version x.y.z."

  step "7/12" "Docker Engine"
  if docker compose version >/dev/null 2>&1; then start_docker_daemon; ok "Docker đang chạy"; else install_docker; fi

  if [[ "$APP_VER" != "$cur_ver" ]]; then
    step "8/12" "Lấy cấu hình triển khai v$APP_VER"
    if [[ -d "$DIR/.git" ]]; then
      if [[ -n "$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
        die "Thư mục $DIR có file đã sửa tay ($(git -C "$DIR" status --porcelain --untracked-files=no | awk '{print $2}' | tr '\n' ' ')). Xem docs/deploy-vps.md 11.2 rồi chạy lại."
      fi
      old_head=$(git -C "$DIR" rev-parse HEAD)
      run "git fetch tag" git_auth -C "$DIR" fetch -q --depth 1 origin "refs/tags/v$APP_VER:refs/tags/v$APP_VER" || die "Không tải được tag v$APP_VER (xem $LOG)."
      run "git checkout" git -C "$DIR" -c advice.detachedHead=false checkout -q "v$APP_VER" || die "Không chuyển được sang v$APP_VER (xem $LOG)."
      if git -C "$DIR" diff --name-only "$old_head" HEAD 2>/dev/null | grep -qE '^(Caddyfile|deploy/caddy/)'; then caddy_changed=1; fi
      ok "Cấu hình triển khai: v$APP_VER"
    else
      warn "$DIR không phải repo git: chỉ đổi APP_VERSION."
    fi
    cp -p "$DIR/.env" "$DIR/.env.bak"
    env_set APP_VERSION "$APP_VER"
  fi

  ghcr_login

  step "10/12" "Cập nhật .env (giữ nguyên khoá bí mật)"
  [[ "$(env_get UPDATE_REPO)" == "$REPO" ]] || env_set UPDATE_REPO "$REPO"
  if [[ "$(env_get UPDATE_GITHUB_TOKEN)" != "$GH_TOKEN" ]]; then
    env_set UPDATE_GITHUB_TOKEN "$GH_TOKEN"
    ok "Đã lưu token GitHub mới vào .env"
  else
    ok "Token GitHub trong .env: không đổi"
  fi
  [[ -n "$(env_get HOST_PROJECT_DIR)" ]] || env_set HOST_PROJECT_DIR "$DIR"
  if [[ "$OPT_UPDATER" == "0" ]]; then
    env_set COMPOSE_PROFILES ""
  elif [[ "$OPT_UPDATER" == "1" || -z "$(grep -E '^COMPOSE_PROFILES=' "$DIR/.env" || true)" ]]; then
    env_set COMPOSE_PROFILES updater
  fi
  chmod 600 "$DIR/.env"
  ok "Biến cập nhật trong .env: UPDATE_REPO, UPDATE_GITHUB_TOKEN, HOST_PROJECT_DIR, COMPOSE_PROFILES=${cur_profiles:-(trống)}→$(env_get COMPOSE_PROFILES)"

  step "11/12" "Khởi chạy"
  if [[ "$APP_VER" != "$cur_ver" ]]; then
    run "docker compose pull" dc pull -q || { explain_pull_error; die "Không tải được image v$APP_VER."; }
  fi
  [[ "$OPT_UPDATER" == "0" ]] && run "remove updater" dc rm -sf updater || true
  run "docker compose up" dc up -d --no-build || { explain_pull_error; show_log_tail 25; die "docker compose up thất bại."; }
  if [[ $caddy_changed -eq 1 && "$(svc_field "$(compose_json)" caddy State)" == "running" ]]; then
    run "restart caddy" dc restart caddy && ok "Đã nạp lại Caddy (Caddyfile / deploy/caddy thay đổi)"
  fi
  wait_stack
  ok "web healthy"
  check_https
  SWAP_STATE="không đổi ($(swap_mb) MB)"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then FIREWALL_STATE="UFW đang bật (không đổi)"; else FIREWALL_STATE="UFW không bật (không đổi)"; fi
  post_checks
}

# ------------------------------------------------------------------------------------------------------------------
# Final screen (terminal only - never written to the log)
# ------------------------------------------------------------------------------------------------------------------
final_screen() {
  local setup_key elapsed mins secs line exp_txt
  line="════════════════════════════════════════════════════════════════════════"
  elapsed=$(($(date +%s) - START_TS))
  mins=$((elapsed / 60))
  secs=$((elapsed % 60))
  if [[ -n "$TOKEN_EXPIRY_EPOCH" ]]; then
    exp_txt="hết hạn $(vn_date "$TOKEN_EXPIRY_EPOCH") (còn $(((TOKEN_EXPIRY_EPOCH - $(date +%s)) / 86400)) ngày)"
  else
    exp_txt="không có ngày hết hạn"
  fi
  log "install finished: mode=$MODE version=$APP_VER https='$HTTPS_STATE' users=$USER_COUNT elapsed=${elapsed}s"
  printf '\n%s%s%s\n' "$C_GRN" "$line" "$C_RST"
  if [[ "$MODE" == "repair" ]]; then
    printf '%s ✅ ĐÃ SỬA CHỮA XONG — Ads MCP by Nextgency v%s%s\n' "$C_GRN$C_BLD" "$APP_VER" "$C_RST"
  else
    printf '%s ✅ CÀI ĐẶT THÀNH CÔNG — Ads MCP by Nextgency v%s%s\n' "$C_GRN$C_BLD" "$APP_VER" "$C_RST"
  fi
  printf '%s%s%s\n\n' "$C_GRN" "$line" "$C_RST"

  if [[ "$USER_COUNT" == "0" ]]; then
    setup_key=$(env_get SETUP_TOKEN)
    printf '%s👉 BƯỚC TIẾP THEO: tạo tài khoản quản trị (admin)%s\n' "$C_BLD" "$C_RST"
    printf '   1. Mở trình duyệt:  %shttps://%s/setup%s\n' "$C_BLU" "$DOMAIN" "$C_RST"
    printf '   2. Nhập MÃ CÀI ĐẶT (setup key):\n\n'
    printf '        %s%s%s\n\n' "$C_YLW$C_BLD" "$setup_key" "$C_RST"
    printf '   3. Nhập tên, email, mật khẩu mạnh → tạo tài khoản. Trang /setup tự khoá khi đã có tài khoản.\n'
    printf '   Xem lại mã: sudo ads-mcp setup-key   (không gửi mã này qua chat/email)\n\n'
  else
    printf '%s👉 Hệ thống đã có tài khoản quản trị (%s tài khoản).%s Đăng nhập: https://%s\n' "$C_BLD" "$USER_COUNT" "$C_RST" "$DOMAIN"
    printf '   Quên mật khẩu: cd %s && docker compose run --rm web node dist/cli.mjs reset-password <email>\n\n' "$DIR"
  fi

  printf '%s📋 Thông tin cài đặt%s\n' "$C_BLD" "$C_RST"
  printf '   Thư mục:            %s\n' "$DIR"
  printf '   File cấu hình:      %s/.env  %s⚠ chứa khoá bí mật: SAO LƯU NGAY vào nơi an toàn khác máy chủ%s\n' "$DIR" "$C_YLW" "$C_RST"
  printf '   Phiên bản:          %s\n' "$APP_VER"
  printf '   HTTPS:              %s\n' "${HTTPS_STATE:-chưa xác nhận}"
  printf '   Cập nhật tự động:   %s\n' "${UPDATER_STATE:-?}"
  printf '   Token GitHub:       tài khoản %s, %s — đổi token: sudo ads-mcp token\n' "$GH_USER" "$exp_txt"
  printf '   Swap:               %s\n' "${SWAP_STATE:-?}"
  printf '   Tường lửa:          %s\n' "${FIREWALL_STATE:-?}"
  printf '   Thời gian:          %d phút %d giây\n' "$mins" "$secs"
  printf '   Nhật ký cài đặt:    %s\n\n' "$LOG"

  printf '%s🔒 Nên làm sau khi tạo admin%s\n' "$C_BLD" "$C_RST"
  printf '   • Tài khoản → bật xác thực 2 lớp (2FA), cất 10 mã dự phòng ở nơi an toàn.\n'
  printf '   • Cài đặt → Bảo mật → bật "Bắt buộc 2FA cho quản trị viên".\n'
  printf '   • Đưa bản sao lưu (%s/backups) ra ngoài máy chủ, có mã hoá (docs/deploy-vps.md 12.2).\n' "$DIR"
  printf '   • Cài đặt → Cập nhật → Kiểm tra ngay: phải thấy bản mới nhất, không báo lỗi token.\n\n'

  printf '%s🛠 Lệnh hữu ích%s\n' "$C_BLD" "$C_RST"
  printf '   sudo ads-mcp status        trạng thái các dịch vụ\n'
  printf '   sudo ads-mcp doctor        tự kiểm tra và gợi ý cách sửa\n'
  printf '   sudo ads-mcp logs [web]    xem nhật ký (Ctrl+C để thoát)\n'
  printf '   sudo ads-mcp setup-key     xem lại mã cài đặt\n'
  printf '   sudo ads-mcp token         đổi token GitHub\n'
  printf '   sudo ads-mcp backup        sao lưu database ngay\n'
  printf '   sudo ads-mcp help          tất cả lệnh\n'
  printf '%s%s%s\n' "$C_GRN" "$line" "$C_RST"
}

# ------------------------------------------------------------------------------------------------------------------
main() {
  parse_args "$@"
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Cần quyền root. Chạy lại bằng: sudo bash $(basename "${BASH_SOURCE[0]:-install-ads-mcp.sh}") $*"
  ((BASH_VERSINFO[0] >= 4)) || die "Cần bash 4 trở lên."
  trap 'on_error $? $LINENO' ERR
  trap cleanup EXIT
  umask 022
  TMPD=$(mktemp -d /tmp/ads-mcp-install.XXXXXX)
  chmod 700 "$TMPD"
  detect_tty
  # secrets from the environment go into unexported shell variables; child processes never inherit them
  ENV_GITHUB_TOKEN=${ADS_MCP_GITHUB_TOKEN:-}
  ENV_TUNNEL_TOKEN=${ADS_MCP_TUNNEL_TOKEN:-}
  unset ADS_MCP_GITHUB_TOKEN ADS_MCP_TUNNEL_TOKEN
  # children must never read the script itself when it is piped (curl ... | sudo bash)
  exec </dev/null
  init_log
  printf '%sAds MCP by: Nextgency — trình cài đặt %s%s\n' "$C_BLD" "$INSTALLER_VERSION" "$C_RST"
  printf 'Nhật ký: %s (không chứa token hay mật khẩu)\n' "$LOG"
  export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"

  precheck
  base_tools
  if [[ "$MODE" == "repair" ]]; then
    repair
  else
    questions
    dns_check
    setup_swap
    setup_firewall
    install_docker
    fetch_source
    ghcr_login
    write_env
    start_stack
    post_checks
  fi
  final_screen
}

if [[ "${ADS_MCP_INSTALL_SOURCE_ONLY:-}" != "1" ]]; then
  main "$@"
fi
