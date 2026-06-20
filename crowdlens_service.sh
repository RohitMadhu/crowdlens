#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1280x1024x24}"
CDP_PORT="${CDP_PORT:-9222}"
BROWSER_RUNTIME="${BROWSER_RUNTIME:-obscura}"
THORIUM_BIN="${THORIUM_BIN:-thorium-browser}"
CLOAK_BIN="${CLOAK_BIN:-}"
OBSCURA_BIN="${OBSCURA_BIN:-obscura}"
OBSCURA_STEALTH="${OBSCURA_STEALTH:-1}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/crowdlens-browser-profile}"
LOG_DIR="${LOG_DIR:-$HOME/.cache/crowdlens}"
START_URL="${START_URL:-about:blank}"
JS_OLD_SPACE_MB="${JS_OLD_SPACE_MB:-128}"

mkdir -p "$PROFILE_DIR" "$LOG_DIR"

cleanup() {
  if [[ -n "${browser_pid:-}" ]] && kill -0 "$browser_pid" 2>/dev/null; then
    kill "$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
  fi
  if [[ -n "${xvfb_pid:-}" ]] && kill -0 "$xvfb_pid" 2>/dev/null; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

launch_cloak() {
  local bin="$1"
  local log_file="$2"

  "$bin" \
    --headless=new \
    --remote-debugging-port="$CDP_PORT" \
    --remote-debugging-address=127.0.0.1 \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "$START_URL" >"$log_file" 2>&1 &
  browser_pid=$!
}

launch_low_footprint_chromium() {
  local bin="$1"
  local log_file="$2"

  "$bin" \
    --headless=new \
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
    "$START_URL" >"$log_file" 2>&1 &
  browser_pid=$!
}

case "$BROWSER_RUNTIME" in
  cloak|clark)
    CLOAK_LOG="$LOG_DIR/cloak-browser.log"

    if [[ -z "$CLOAK_BIN" ]]; then
      if command -v cloakbrowser >/dev/null 2>&1; then
        CLOAK_BIN="$(cloakbrowser info | awk '/^Binary:/ {print $2}')"
      else
        echo "CLOAK_BIN is required, or install the cloakbrowser CLI on PATH" >&2
        exit 1
      fi
    fi

    if [[ ! -x "$CLOAK_BIN" ]]; then
      echo "Cloak/Clark browser binary '$CLOAK_BIN' was not found or is not executable" >&2
      exit 1
    fi

    launch_cloak "$CLOAK_BIN" "$CLOAK_LOG"
    ;;
  obscura)
    OBSCURA_LOG="$LOG_DIR/obscura.log"

    if ! command -v "$OBSCURA_BIN" >/dev/null 2>&1; then
      echo "Obscura binary '$OBSCURA_BIN' was not found on PATH" >&2
      exit 1
    fi

    obscura_args=(serve --port "$CDP_PORT" --host 127.0.0.1)
    if [[ "$OBSCURA_STEALTH" == "1" ]]; then
      obscura_args+=(--stealth)
    fi

    "$OBSCURA_BIN" "${obscura_args[@]}" >"$OBSCURA_LOG" 2>&1 &
    browser_pid=$!
    ;;
  thorium)
    if ! command -v Xvfb >/dev/null 2>&1; then
      echo "Xvfb is required for Thorium but was not found on PATH" >&2
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

    sleep 1
    export DISPLAY

    launch_low_footprint_chromium "$THORIUM_BIN" "$THORIUM_LOG"
    ;;
  *)
    echo "Unsupported BROWSER_RUNTIME '$BROWSER_RUNTIME'. Use cloak, obscura, or thorium." >&2
    exit 1
    ;;
esac

wait "$browser_pid"
