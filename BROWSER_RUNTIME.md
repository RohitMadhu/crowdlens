# CrowdLens Browser Runtime

CrowdLens uses raw Chrome DevTools Protocol over WebSocket. The scraper itself
does not depend on Playwright, Puppeteer, or npm packages; it only needs a
browser exposing CDP.

## Runtime Choice

Use `BROWSER_RUNTIME=obscura` as the preferred runtime. With the current
Obscura session on `127.0.0.1:9222`, Google Maps renders the place panel and
exposes popular-times labels after a brief CDP detach/resample.

Use `BROWSER_RUNTIME=cloak` as the Chromium fallback. CloakBrowser hydrated
Maps too, but it is still a full Chromium build and is much closer to Thorium's
resource profile than Obscura's.

Use `BROWSER_RUNTIME=thorium` only as the legacy fallback.

## What It Extracts

`crowdlens.mjs` opens a Google Maps URL and extracts:

- title
- secondary title
- address
- website
- phone
- current hours line
- limited-view status
- visible popularity phrases
- popularity-related `aria-label` values
- current busy percentage and usual comparison when Maps exposes them
- hourly popular-times buckets when Maps exposes them

It also supports query mode and can follow the first `/maps/place/` link when a
search lands on a results list. Because it speaks raw CDP and uses Node's
built-in WebSocket client, it has no npm runtime dependencies.

## Install Obscura

Install or build Obscura, then run it as a CDP server:

```bash
obscura serve --port 9222 --host 127.0.0.1 --stealth
```

Check that CDP is live:

```bash
curl -s http://127.0.0.1:9222/json/version
```

Expected shape:

```json
{
  "Browser": "Obscura/0.1.0",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser"
}
```

## Service Launch

The service defaults to Obscura:

```bash
./crowdlens_service.sh
```

Or explicitly:

```bash
BROWSER_RUNTIME=obscura \
OBSCURA_BIN="/path/to/obscura" \
./crowdlens_service.sh
```

For CloakBrowser fallback:

```bash
BROWSER_RUNTIME=cloak \
CLOAK_BIN="/path/to/Chromium" \
./crowdlens_service.sh
```

For legacy Thorium:

```bash
BROWSER_RUNTIME=thorium \
THORIUM_BIN=thorium-browser \
./crowdlens_service.sh
```

## Query Examples

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
  --query "Costco Brooklyn NY"
```

Use the current page that is already open in the browser without navigating:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --inspect-current-page
```

## Timing Notes

Obscura can expose a weak snapshot immediately after navigation and then hydrate
the useful Maps panel a few seconds later. `crowdlens.mjs` first polls for
popular-times signals for up to `--popular-times-wait-ms` milliseconds, then
falls back to a post-detach resample if the snapshot is still weak.

Tune the polling window:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --query "Costco Brooklyn NY" \
  --popular-times-wait-ms 20000
```

Disable the post-detach fallback only when debugging:

```bash
node crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --query "Costco Brooklyn NY" \
  --no-post-detach-resample
```

Fresh profiles can also return Google's limited Maps view on the first
navigation. `crowdlens.mjs` retries one limited-view navigation by default; tune
this with `--limited-view-retries`.

## Notes

- `--cdp-url` accepts either `http://127.0.0.1:9222` or a full
  `ws://.../devtools/browser/...` endpoint.
- Obscura is the lightest successful path we have tested so far.
- CloakBrowser remains useful if Obscura regresses, but it is Chromium-class in
  memory and disk footprint.
- The scraper does not attempt to bypass CAPTCHA or anti-bot challenges.
