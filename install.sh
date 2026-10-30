#!/usr/bin/env bash
# One-click installer of circle-hub (owner decision 76): macOS and Linux only.
#
#   curl -fsSL https://raw.githubusercontent.com/circle-platforms/circle-hub/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/circle-platforms/circle-hub/main/install.sh | bash -s -- --https-host 192.168.1.20
#
# It downloads the release bundle for this machine (Node 24, the Hub with its dependencies and PostgreSQL), checks it
# against the SHA-256 list of the GitHub release, and sets the Hub up with its own commands: init (HTTP on loopback, HTTPS
# on the given address), key init, tls init, deploy --bundle, which installs and starts the service, and setup-code for
# the first administrator, created in the browser at /console/setup. Run again to upgrade: deploy backs up, migrates and
# rolls back on failure. macOS: the current user, a LaunchAgent and the login keychain. Linux: a dedicated `circle-hub`
# account with its systemd user service (lingering), bubblewrap and the Hub's AppArmor policy for the pack sandbox;
# root (sudo) is needed for those steps only. Nothing else on the machine is changed.
set -euo pipefail

REPO="${CIRCLE_HUB_INSTALL_REPO:-circle-platforms/circle-hub}"
VERSION=""
BUNDLE_FILE=""
ENVIRONMENT="production"
HTTP_PORT="7420"
HTTPS_PORT="7443"
HTTPS_HOST=""
EXTRA_HOSTS=""
DRY_RUN=0

say() { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：install.sh [选项]
  --version <x.y.z>        安装指定版本（默认最新发行版）
  --https-host <内网 IP>    在这个内网地址上开 HTTPS，供浏览器和其他电脑上的 Circle 访问（默认只在本机）
  --hostname <名字>         另外允许的主机名（可重复，例如 hub.example.lan；证书也会覆盖它）
  --https-port <端口>       HTTPS 端口（默认 7443）
  --port <端口>             本机 HTTP 端口（默认 7420，只监听 127.0.0.1）
  --environment <类别>      环境类别 test、shared 或 production（默认 production）
  --bundle <文件>           用本地的发布包代替下载（同目录下要有 SHA256SUMS）
  --dry-run                只显示要做什么，不改动任何东西
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?}"; shift 2 ;;
    --https-host) HTTPS_HOST="${2:?}"; shift 2 ;;
    --hostname) EXTRA_HOSTS="${EXTRA_HOSTS:+${EXTRA_HOSTS},}${2:?}"; shift 2 ;;
    --https-port) HTTPS_PORT="${2:?}"; shift 2 ;;
    --port) HTTP_PORT="${2:?}"; shift 2 ;;
    --environment) ENVIRONMENT="${2:?}"; shift 2 ;;
    --bundle) BUNDLE_FILE="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "不认识的选项：$1" ;;
  esac
done

case "${ENVIRONMENT}" in test|shared|production) ;; *) fail "环境类别只能是 test、shared 或 production" ;; esac
for port in "${HTTP_PORT}" "${HTTPS_PORT}"; do
  case "$port" in ''|*[!0-9]*) fail "端口要是数字：$port" ;; esac
done
[ "${HTTP_PORT}" != "${HTTPS_PORT}" ] || fail "HTTP 和 HTTPS 端口不能相同"

# ---------------------------------------------------------------- this machine

OS="${CIRCLE_HUB_INSTALL_OS:-$(uname -s)}"
ARCH="${CIRCLE_HUB_INSTALL_ARCH:-$(uname -m)}"
case "${OS}" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "circle-hub 只支持 macOS 和 Linux，这台机器是 ${OS}" ;;
esac
case "${ARCH}" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail "不支持的处理器架构：${ARCH}（只有 arm64 和 x64 的发布包）" ;;
esac
PLATFORM="${OS}-${ARCH}"

ALLOWED=""
if [ -n "${HTTPS_HOST}" ]; then
  case "${HTTPS_HOST}" in
    127.*|::1|0.0.0.0|::) fail "--https-host 要写这台机器的内网 IP；只在本机访问时不用这个选项" ;;
  esac
  ALLOWED="${HTTPS_HOST}${EXTRA_HOSTS:+,${EXTRA_HOSTS}}"
elif [ -n "${EXTRA_HOSTS}" ]; then
  fail "--hostname 要和 --https-host 一起用"
fi

run() {
  if [ "${DRY_RUN}" = 1 ]; then printf '将执行：%s\n' "$*"; else "$@"; fi
}

SUDO=""
if [ "${OS}" = linux ]; then
  [ -d /run/systemd/system ] || [ "${DRY_RUN}" = 1 ] || fail "这台 Linux 没有运行 systemd；Hub 的服务需要 systemd"
  if [ "$(id -u)" = 0 ]; then SUDO=""; else
    command -v sudo >/dev/null 2>&1 || fail "Linux 上要用 root 或 sudo 建立服务账户和沙箱策略"
    SUDO="sudo"
  fi
fi

# ---------------------------------------------------------------- the bundle

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ -n "${BUNDLE_FILE}" ]; then
  [ -f "${BUNDLE_FILE}" ] || fail "没有这个发布包：${BUNDLE_FILE}"
  SUMS="$(dirname "${BUNDLE_FILE}")/SHA256SUMS"
  [ -f "${SUMS}" ] || fail "发布包旁边没有 SHA256SUMS：${SUMS}"
  NAME="$(basename "${BUNDLE_FILE}")"
  cp "${BUNDLE_FILE}" "${WORK}/${NAME}"
  cp "${SUMS}" "${WORK}/SHA256SUMS"
else
  if [ -z "${VERSION}" ]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)"
    [ -n "${VERSION}" ] || fail "查不到最新发行版；用 --version 指定版本"
  fi
  NAME="circle-hub-${VERSION}-${PLATFORM}.tar.gz"
  BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
  say "下载 ${NAME}"
  if [ "${DRY_RUN}" = 1 ]; then
    say "将下载：${BASE}/${NAME} 和 ${BASE}/SHA256SUMS"
  else
    curl -fL --progress-bar -o "${WORK}/${NAME}" "${BASE}/${NAME}" || fail "下载失败：${BASE}/${NAME}（这个版本可能没有一键安装包：一键安装从 0.3.0 起，用 --version 指定）"
    curl -fsSL -o "${WORK}/SHA256SUMS" "${BASE}/SHA256SUMS" || fail "下载失败：${BASE}/SHA256SUMS"
  fi
fi

if [ "${DRY_RUN}" != 1 ]; then
  EXPECTED="$(awk -v name="${NAME}" '$2 == name { print $1 }' "${WORK}/SHA256SUMS")"
  [ -n "${EXPECTED}" ] || fail "SHA256SUMS 里没有 ${NAME}"
  ACTUAL="$(sha256_of "${WORK}/${NAME}")"
  [ "${EXPECTED}" = "${ACTUAL}" ] || fail "${NAME} 的 SHA-256 不符（期望 ${EXPECTED}，实际 ${ACTUAL}）：不安装"
  say "已核对 SHA-256：${ACTUAL}"
fi
BUNDLE_DIR_NAME="${NAME%.tar.gz}"

# ---------------------------------------------------------------- per system

# Every deploy backs the database up first with pg_dump and pg_restore of the server's major version (PostgreSQL 18).
LIBPQ_BIN=""
pg18() { [ -x "$1/pg_dump" ] && [ -x "$1/pg_restore" ] && "$1/pg_dump" --version 2>/dev/null | grep -q ' 18\.'; }

if [ "${OS}" = darwin ]; then
  DATA="${CIRCLE_HUB_DATA_DIR:-${HOME}/Library/Application Support/circle-hub}"
  WRAPPER_DIR="${HOME}/.local/bin"
  for candidate in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
    if pg18 "${candidate}"; then LIBPQ_BIN="${candidate}"; break; fi
  done
  if [ -z "${LIBPQ_BIN}" ]; then
    if command -v brew >/dev/null 2>&1; then
      say "安装备份要用的 PostgreSQL 客户端（Homebrew 的 libpq）"
      run brew install libpq
      LIBPQ_BIN="$(brew --prefix libpq 2>/dev/null)/bin"
    elif [ "${DRY_RUN}" != 1 ]; then
      fail "部署前要先备份数据库，需要 PostgreSQL 18 的 pg_dump 和 pg_restore：先安装 Homebrew（https://brew.sh），再重新运行；或装好 libpq 后设置 CIRCLE_HUB_LIBPQ_BIN"
    fi
  fi
else
  # The platform's data root of the circle-hub account (hub/platform/layout.ts defaultDataRoot), composed the same way.
  SYSTEM_STATE=/var
  DATA="${SYSTEM_STATE}/lib/circle-hub"
  WRAPPER_DIR="/usr/local/bin"
fi
RUNTIME="${DATA}/runtime"
BUNDLE="${RUNTIME}/bundles/${BUNDLE_DIR_NAME}"
NODE="${RUNTIME}/node/bin/node"
SETUP_HUB="${BUNDLE}/app/bin/circle-hub"

# Runs a command as the account that owns the data directory: this user on macOS, circle-hub on Linux. A function, not an
# array: macOS ships bash 3.2, where an empty array is an unbound variable under set -u.
as_hub() {
  if [ "${OS}" = darwin ]; then "$@"
  elif [ -z "${SUDO}" ]; then runuser -u circle-hub -- env HOME="${DATA}" "$@"
  else sudo -u circle-hub -H "$@"; fi
}
run_as_hub() {
  if [ "${DRY_RUN}" = 1 ]; then printf '将以数据目录的账户执行：%s\n' "$*"; else as_hub "$@"; fi
}
hub() { run_as_hub "${NODE}" "${SETUP_HUB}" "$@"; }
commit_in() { as_hub sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$1" 2>/dev/null | head -n1 || true; }

if [ "${OS}" = linux ]; then
  if command -v apt-get >/dev/null 2>&1; then
    say "安装包函数沙箱需要的 bubblewrap、AppArmor 工具，和备份要用的 PostgreSQL 18 客户端"
    run ${SUDO} apt-get update -qq
    run ${SUDO} apt-get install -y bubblewrap apparmor ca-certificates curl
    if ! pg18 /usr/lib/postgresql/18/bin; then
      if ! run ${SUDO} apt-get install -y postgresql-client-18; then
        say "系统软件源里没有 postgresql-client-18：加入 PostgreSQL 官方 apt 源（apt.postgresql.org）"
        CODENAME="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
        [ -n "${CODENAME}" ] || fail "无法确定发行版代号；请手动安装 PostgreSQL 18 客户端后重试"
        run ${SUDO} install -d /usr/share/postgresql-common/pgdg
        run ${SUDO} curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
        if [ "${DRY_RUN}" != 1 ]; then
          printf 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "${CODENAME}" | ${SUDO} tee /etc/apt/sources.list.d/pgdg.list >/dev/null
        fi
        run ${SUDO} apt-get update -qq
        run ${SUDO} apt-get install -y postgresql-client-18
      fi
    fi
  else
    say "注意：这台机器没有 apt-get；请自行安装 PostgreSQL 18 客户端（pg_dump、pg_restore），以及包函数沙箱要的 /usr/bin/bwrap、/usr/bin/aa-exec 和 apparmor_parser"
  fi
  LIBPQ_BIN="/usr/lib/postgresql/18/bin"
  if ! id circle-hub >/dev/null 2>&1; then
    say "建立服务账户 circle-hub（数据目录 ${DATA}）"
    run ${SUDO} useradd --system --home-dir "${DATA}" --create-home --shell /usr/sbin/nologin circle-hub
  fi
  run ${SUDO} chmod 700 "${DATA}"
  run ${SUDO} loginctl enable-linger circle-hub
  if [ "${DRY_RUN}" != 1 ]; then
    ${SUDO} systemctl start "user@$(id -u circle-hub).service"
  fi
fi

say "解开发布包到 ${BUNDLE}"
run_as_hub mkdir -p "${RUNTIME}/bundles" "${RUNTIME}/downloads"
if [ "${DRY_RUN}" != 1 ]; then
  DOWNLOAD="${RUNTIME}/downloads/${NAME}"
  if [ "${OS}" = linux ]; then
    ${SUDO} install -o circle-hub -m 0600 "${WORK}/${NAME}" "${DOWNLOAD}"
  else
    install -m 0600 "${WORK}/${NAME}" "${DOWNLOAD}"
  fi
  if ! as_hub test -d "${BUNDLE}"; then
    as_hub tar -x -z -f "${DOWNLOAD}" -C "${RUNTIME}/bundles"
  fi
  as_hub rm -f "${DOWNLOAD}"
  as_hub test -f "${BUNDLE}/bundle.json" || fail "发布包里没有 bundle.json"
  as_hub ln -sfn "bundles/${BUNDLE_DIR_NAME}/node" "${RUNTIME}/node"
fi

if [ "${OS}" = linux ]; then
  say "装载 Hub 的 AppArmor 策略（对这个 Node）"
  if [ "${DRY_RUN}" = 1 ]; then
    say "将执行：${NODE} ${BUNDLE}/app/hub/rules/sandbox/linux.ts | ${SUDO:-} apparmor_parser -r"
  elif command -v apparmor_parser >/dev/null 2>&1; then
    as_hub "${NODE}" "${BUNDLE}/app/hub/rules/sandbox/linux.ts" | ${SUDO} apparmor_parser -r
  else
    say "注意：没有 apparmor_parser，跳过；任务包里的函数在装好 AppArmor 之前不能运行"
  fi
fi

SETTINGS="${DATA}/config/platform.json"
FRESH=0
if [ "${DRY_RUN}" = 1 ] || ! as_hub test -f "${SETTINGS}"; then
  FRESH=1
  say "初始化数据目录和数据库"
  INIT=(init --environment "${ENVIRONMENT}" --port "${HTTP_PORT}" --https-port "${HTTPS_PORT}")
  if [ -n "${HTTPS_HOST}" ]; then INIT+=(--https-host "${HTTPS_HOST}"); fi
  if [ -n "${ALLOWED}" ]; then
    run_as_hub env CIRCLE_HUB_ALLOWED_HOSTS="${ALLOWED}" "${NODE}" "${SETUP_HUB}" "${INIT[@]}"
  else
    hub "${INIT[@]}"
  fi
else
  say "沿用已有的部署设置：${SETTINGS}（这次给的端口和地址不改它）"
fi

if [ "${DRY_RUN}" = 1 ] || ! as_hub "${NODE}" "${SETUP_HUB}" key status >/dev/null 2>&1; then
  hub key init
fi
if [ "${DRY_RUN}" = 1 ] || ! as_hub "${NODE}" "${SETUP_HUB}" tls status >/dev/null 2>&1; then
  hub tls init
fi

COMMIT=""
CURRENT=""
if [ "${DRY_RUN}" != 1 ]; then
  COMMIT="$(commit_in "${BUNDLE}/bundle.json")"
  if as_hub test -f "${DATA}/current/release.json"; then CURRENT="$(commit_in "${DATA}/current/release.json")"; fi
fi
if [ "${DRY_RUN}" = 1 ] || [ -z "${COMMIT}" ] || [ "${COMMIT}" != "${CURRENT}" ]; then
  say "部署并启动服务"
  run_as_hub env ${LIBPQ_BIN:+CIRCLE_HUB_LIBPQ_BIN="${LIBPQ_BIN}"} "${NODE}" "${SETUP_HUB}" deploy --bundle "${BUNDLE}" --node "${NODE}"
else
  say "这一版已经在运行，不重新部署"
fi

say "安装命令 circle-hub 到 ${WRAPPER_DIR}"
if [ "${DRY_RUN}" != 1 ]; then
  WRAPPER="${WORK}/circle-hub"
  if [ "${OS}" = darwin ]; then
    {
      printf '#!/bin/sh\n# circle-hub, installed by install.sh: the bundled Node and the deployed release.\n'
      if [ -n "${LIBPQ_BIN}" ]; then printf ': "${CIRCLE_HUB_LIBPQ_BIN:=%s}"\nexport CIRCLE_HUB_LIBPQ_BIN\n' "${LIBPQ_BIN}"; fi
      printf 'exec "%s" "%s" "$@"\n' "${NODE}" "${DATA}/current/bin/circle-hub"
    } > "${WRAPPER}"
    mkdir -p "${WRAPPER_DIR}"
    install -m 0755 "${WRAPPER}" "${WRAPPER_DIR}/circle-hub"
  else
    {
      printf '#!/bin/sh\n# circle-hub, installed by install.sh: runs as the circle-hub service account.\n'
      printf 'if [ "$(id -un)" = circle-hub ]; then exec env CIRCLE_HUB_LIBPQ_BIN="%s" "%s" "%s" "$@"; fi\n' "${LIBPQ_BIN}" "${NODE}" "${DATA}/current/bin/circle-hub"
      printf 'exec sudo -u circle-hub -H env CIRCLE_HUB_LIBPQ_BIN="%s" "%s" "%s" "$@"\n' "${LIBPQ_BIN}" "${NODE}" "${DATA}/current/bin/circle-hub"
    } > "${WRAPPER}"
    ${SUDO} install -m 0755 "${WRAPPER}" "${WRAPPER_DIR}/circle-hub"
  fi
fi

CODE=""
if [ "${DRY_RUN}" != 1 ]; then
  CODE="$(as_hub "${NODE}" "${DATA}/current/bin/circle-hub" setup-code 2>/dev/null | sed -n '2p' || true)"
fi

HOST_FOR_URL="${HTTPS_HOST:-127.0.0.1}"
say ""
say "circle-hub 已安装。"
say "  控制台：https://${HOST_FOR_URL}:${HTTPS_PORT}/console/"
say "  本机 HTTP：http://127.0.0.1:${HTTP_PORT}/console/"
say "  证书颁发机构：${DATA}/tls/ca.crt（浏览器和 Circle 信任它之前，先用 circle-hub tls status 核对指纹）"
if [ -n "${CODE}" ]; then
  say "  设置码（24 小时内有效）：${CODE}"
  say "  打开 https://${HOST_FOR_URL}:${HTTPS_PORT}/console/setup，用设置码建立第一位管理员。"
elif [ "${FRESH}" = 1 ] && [ "${DRY_RUN}" != 1 ]; then
  say "  没拿到设置码：运行 circle-hub setup-code 生成"
fi
if [ "${OS}" = darwin ]; then
  case ":${PATH}:" in *":${WRAPPER_DIR}:"*) ;; *) say "  把 ${WRAPPER_DIR} 加进 PATH 后就能直接用 circle-hub 命令" ;; esac
fi
if [ -z "${HTTPS_HOST}" ]; then
  say "  现在只能在本机访问。要让内网其他电脑访问，重新安装时加 --https-host <这台机器的内网 IP>（已有部署时要先改部署设置，见文档）。"
fi
