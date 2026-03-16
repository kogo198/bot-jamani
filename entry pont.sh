#!/bin/sh
# ═══════════════════════════════════════════════════════
#  TCT  WhatsApp Bot — Entrypoint Script  v2.0
#  Runs inside Docker / Linux / Render / Heroku
# ═══════════════════════════════════════════════════════
set -e

# ── Colours ──────────────────────────────────────────────
R='\033[0;31m'   # red
G='\033[0;32m'   # green
Y='\033[0;33m'   # yellow
C='\033[0;36m'   # cyan
B='\033[1m'      # bold
N='\033[0m'      # reset

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
info()  { printf "${C}[%s][INFO]${N}  %s\n"  "$(ts)" "$1"; }
ok()    { printf "${G}[%s][OK]${N}    %s\n"  "$(ts)" "$1"; }
warn()  { printf "${Y}[%s][WARN]${N}  %s\n"  "$(ts)" "$1"; }
error() { printf "${R}[%s][ERROR]${N} %s\n"  "$(ts)" "$1"; }

# ── Banner ───────────────────────────────────────────────
printf "${C}${B}
┌──────────────────────────────────────────┐
│     Kiplaa WhatsApp Bot  Entrypoint      │
│            v2.0  ⚡ Modern              │
└──────────────────────────────────────────┘
${N}"

# ═══════════════════════════════════════════════════════
#  1.  BINARY DOWNLOAD
# ═══════════════════════════════════════════════════════
BINARY_NAME="tct-linux"
DOWNLOAD_URL="https://github.com/i-tct/tct/releases/latest/download/${BINARY_NAME}"

info "Ensuring fresh binary installation…"

# Always remove old binary to guarantee latest version
if [ -f "./${BINARY_NAME}" ]; then
    warn "Removing old ${BINARY_NAME}…"
    rm -f "./${BINARY_NAME}"
fi

info "Downloading from: ${DOWNLOAD_URL}"

if command -v curl > /dev/null 2>&1; then
    curl --fail --location --progress-bar "${DOWNLOAD_URL}" -o "${BINARY_NAME}"
elif command -v wget > /dev/null 2>&1; then
    wget --show-progress -O "${BINARY_NAME}" "${DOWNLOAD_URL}"
else
    error "Neither curl nor wget found. Cannot download binary."
    exit 1
fi

chmod +x "${BINARY_NAME}"
ok "Binary ready. Size: $(du -sh "${BINARY_NAME}" | cut -f1)"

# ═══════════════════════════════════════════════════════
#  2.  BUILD .ENV FILE  (fresh, from container env vars)
# ═══════════════════════════════════════════════════════
info "Building .env from environment variables…"

# Remove any stale .env files
rm -f "./.env" "/.env"

ENV_FILE="./.env"

cat > "${ENV_FILE}" << HEADER
# ──────────────────────────────────────────────────────
# .env — generated automatically by entrypoint.sh
# Generated at: $(ts)
# ──────────────────────────────────────────────────────

HEADER

# Helper: write VAR="value" only if the variable is set and non-empty
add_if() {
    varname="$1"
    val="$(eval "printf '%s' \"\${${varname}}\"")"
    if [ -n "${val}" ]; then
        # Escape backslashes and double-quotes
        escaped=$(printf '%s' "${val}" | sed 's/\\/\\\\/g; s/"/\\"/g')
        printf '%s="%s"\n' "${varname}" "${escaped}" >> "${ENV_FILE}"
        info "  Set ${varname}"
    fi
}

# ── Core settings ───────────────────────────────────────
add_if SESSION_ID
add_if PREFIX
add_if TIMEZONE

# ── Database performance settings ───────────────────────
add_if DB_BATCH_SIZE
add_if DB_FLUSH_INTERVAL
add_if DB_CACHE_MAX_BYTES
add_if DB_BUSY_TIMEOUT_MS

# ── Media / integrations ────────────────────────────────
add_if CLOUDINARY_CLOUD_NAME
add_if CLOUDINARY_API_KEY
add_if CLOUDINARY_API_SECRET

# ── AI / Weather ────────────────────────────────────────
add_if OPENWEATHER_API_KEY
add_if MISTRAL_API_KEY

# ── Dashboard ───────────────────────────────────────────
add_if DASHBOARD_USER
add_if DASHBOARD_PASS
add_if server_port

# ── Deploy platform URLs ─────────────────────────────────
add_if RENDER_EXTERNAL_URL

# ── Defaults for missing optional vars ──────────────────
if ! grep -q '^PREFIX=' "${ENV_FILE}" 2>/dev/null; then
    printf 'PREFIX="."\n' >> "${ENV_FILE}"
    warn "PREFIX not set — defaulting to '.'"
fi

if ! grep -q '^DB_BATCH_SIZE=' "${ENV_FILE}" 2>/dev/null; then
    printf 'DB_BATCH_SIZE="600"\n' >> "${ENV_FILE}"
fi

if ! grep -q '^DB_CACHE_MAX_BYTES=' "${ENV_FILE}" 2>/dev/null; then
    printf 'DB_CACHE_MAX_BYTES="268435456"\n' >> "${ENV_FILE}"  # 256 MB
fi

if ! grep -q '^DB_FLUSH_INTERVAL=' "${ENV_FILE}" 2>/dev/null; then
    printf 'DB_FLUSH_INTERVAL="2000"\n' >> "${ENV_FILE}"
fi

ok ".env built successfully at ${ENV_FILE}"

# ── Debug: confirm SESSION_ID is present ────────────────
if grep -q '^SESSION_ID=' "${ENV_FILE}" 2>/dev/null; then
    ok "SESSION_ID is set ✔"
else
    warn "SESSION_ID is NOT set — bot may fail to connect!"
fi

# ═══════════════════════════════════════════════════════
#  3.  LAUNCH THE BOT
# ═══════════════════════════════════════════════════════
info "System info: $(uname -srm)"
info "Available RAM: $(free -h 2>/dev/null | awk '/^Mem:/{print $7}' || echo 'unknown')"

printf "\n${G}${B}▶  Starting TCT bot…${N}\n\n"

if [ "$#" -gt 0 ]; then
    # If arguments passed, run those instead (useful for debugging)
    exec "$@"
else
    exec "./${BINARY_NAME}"
fi