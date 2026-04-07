#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1280x1024x24}"
CDP_PORT="${CDP_PORT:-9222}"
THORIUM_BIN="${THORIUM_BIN:-thorium-browser}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/crowdlens-browser-profile}"
LOG_DIR="${LOG_DIR:-$HOME/.cache/crowdlens}"
START_URL="${START_URL:-about:blank}"
JS_OLD_SPACE_MB="${JS_OLD_SPACE_MB:-64}"

mkdir -p "$PROFILE_DIR" "$LOG_DIR"

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "Xvfb is required but was not found on PATH" >&2
  exit 1
fi

if ! command -v "$THORIUM_BIN" >/dev/null 2>&1; then
  echo "Thorium browser binary '$THORIUM_BIN' was not found on PATH" >&2
  exit 1
fi

DISPLAY=":$DISPLAY_NUM"
XVFB_LOG="$LOG_DIR/xvfb.log"
THORIUM_LOG="$LOG_DIR/thorium-browser.log"

Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -nolisten tcp >"$XVFB_LOG" 2>&1 &
xvfb_pid=$!

cleanup() {
  if [[ -n "${browser_pid:-}" ]] && kill -0 "$browser_pid" 2>/dev/null; then
    kill "$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
  fi
  if kill -0 "$xvfb_pid" 2>/dev/null; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

sleep 1
export DISPLAY

"$THORIUM_BIN" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --enable-low-end-device-mode \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-extensions \
  --disable-component-update \
  --disable-sync \
  --metrics-recording-only \
  --disable-default-apps \
  --mute-audio \
  --js-flags="--max-old-space-size=${JS_OLD_SPACE_MB}" \
  "$START_URL" >"$THORIUM_LOG" 2>&1 &
browser_pid=$!

wait "$browser_pid"
