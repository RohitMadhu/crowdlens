# CrowdLens Browser Runtime

CrowdLens uses raw Chrome DevTools Protocol over WebSocket.
The supported browser target is a running `Thorium` browser session exposed
over CDP.

## What It Does

`crowdlens.mjs` opens a Google Maps URL in Chromium and
extracts:

- title
- secondary title
- address
- website
- phone
- current hours line
- whether Google says the page is a limited view
- any visible popularity-related phrases
- any popularity-related `aria-label` values

It also supports query mode and can follow the first `/maps/place/` link when a
search lands on a results list. Because it speaks raw CDP and uses Node's
built-in WebSocket client, it has no npm runtime dependencies.

## Run It

Requirements:

```bash
node --version
```

Use Node `22.4.0+` so the built-in `WebSocket` client is available.

## Local macOS Launch

For local Thorium testing on macOS:

```bash
open -na "/Applications/Thorium.app" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/crowdlens-profile \
  --no-first-run \
  --no-default-browser-check \
  --enable-low-end-device-mode \
  --disable-gpu \
  --disable-background-networking \
  --disable-extensions \
  --disable-sync \
  --disable-default-apps \
  --mute-audio \
  --skia-font-cache-limit-mb=8 \
  --skia-resource-cache-limit-mb=32 \
  --js-flags=--max-old-space-size=128
```

Then in a second terminal:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --query "Costco Wholesale Yangjae"
```

This command uses the current stable low-footprint Mac flag set:

- `--skia-font-cache-limit-mb=8`
- `--skia-resource-cache-limit-mb=32`
- `--js-flags=--max-old-space-size=128`

If the richer Maps page regresses, the first flags to relax are:

- `--disable-gpu`
- `--skia-font-cache-limit-mb`
- `--skia-resource-cache-limit-mb`

If you see `Runtime.evaluate failed: Target crashed`, that usually means the
renderer ran out of room under the low-memory flag set. The first
recovery path to try is:

1. Raise old-space if you lowered it below `128`
2. Remove `--disable-gpu`
3. Remove the Skia cache limits

If automated navigation still crashes, open the place page manually in Thorium
and then use `--inspect-current-page`.

Against a direct place URL:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --url "https://www.google.com/maps/place/..."
```

Against a query:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --query "Costco Wholesale Yangjae"
```

Force Google Search instead of Maps query mode:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --query "Costco Wholesale Yangjae" \
  --mode search
```

Include raw page text and HTML:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --url "https://www.google.com/maps/place/..." \
  --include-dumps
```

Use the current page that is already open in Thorium without navigating:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --inspect-current-page
```

## Notes

- `--cdp-url` accepts either `http://127.0.0.1:9222` or a full
  `ws://.../devtools/browser/...` endpoint.
- `--inspect-current-page` is useful when automated navigation gets downgraded
  to Google's limited-view page but the visible browser tab is showing the full
  place page.
- It does not attempt to bypass CAPTCHA or anti-bot systems.
- CrowdLens is built around the fuller Thorium Browser path because that is the
  browser flow that has consistently surfaced the richer Google Maps page.
