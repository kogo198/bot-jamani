# ═══════════════════════════════════════════════════════
#  Kiplaa WhatsApp Bot — Dockerfile  (v2.0 optimised)
# ═══════════════════════════════════════════════════════

# ── Base: minimal Debian + only what we need ─────────────
FROM debian:bookworm-slim

# ── Install dependencies in a single, cached layer ───────
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      wget \
      ffmpeg \
      tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean

# ── Set working directory ────────────────────────────────
WORKDIR /app

# ── Copy project files ───────────────────────────────────
COPY . .

# ── Permissions ──────────────────────────────────────────
RUN chmod +x /app/entry\ pont.sh \
 && chmod -R 755 /app/data 2>/dev/null || true

# ── Healthcheck: verify process is alive every 30s ───────
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD pgrep -f tct-linux > /dev/null || exit 1

# ── Environment defaults (overridden by .env / -e flags) ─
ENV TIMEZONE=Africa/Nairobi \
    PREFIX=. \
    FILTER_NOISE_LOGS=true \
    DB_BATCH_SIZE=600 \
    DB_FLUSH_INTERVAL=2000 \
    DB_CACHE_MAX_BYTES=268435456 \
    DB_BUSY_TIMEOUT_MS=8000 \
    FORCE_COLOR=1

# ── Entrypoint ───────────────────────────────────────────
ENTRYPOINT ["/bin/sh", "/app/entry pont.sh"]