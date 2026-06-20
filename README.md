# CrowdLens

CrowdLens extracts place crowd and busy signals from the live Google Maps page.

The current implementation uses:

- persistent Obscura over CDP
- raw Chrome DevTools Protocol
- `crowdlens.mjs`

Primary docs:

- `BROWSER_RUNTIME.md`
- `DEPLOYMENT.md`

The preferred runtime here is Obscura because it can expose the Google Maps
place panel and popular-times labels while staying far lighter than the old
Thorium setup. CloakBrowser remains a Chromium fallback if Obscura regresses.
