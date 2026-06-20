# CrowdLens Deployment

This is the lean production-shaped setup:

- persistent Obscura CDP server
- CDP bound to `127.0.0.1:9222`
- raw CDP scraper client in `crowdlens.mjs`

## Install

On Ubuntu:

```bash
sudo apt update
sudo apt install -y nodejs
node --version
```

Use Node `22.4.0+`. The raw-CDP client relies on Node's built-in `WebSocket`,
so no npm install step is required.

Install or build Obscura, then verify:

```bash
which obscura
obscura --help
```

## Service Files

Copy these files into your server workspace:

- `crowdlens_service.sh`
- `crowdlens.service`
- `crowdlens.mjs`

Make the launcher executable:

```bash
chmod +x /home/ubuntu/crowdlens/crowdlens_service.sh
```

The included unit file assumes your code lives at `/home/ubuntu/crowdlens`.
If it does not, update these fields in `crowdlens.service`:

- `WorkingDirectory`
- `ExecStart`
- `LOG_DIR`

If `obscura` is not on the service user's `PATH`, set `OBSCURA_BIN` in
`crowdlens.service` to the full binary path.

## Enable The Service

```bash
sudo cp /home/ubuntu/crowdlens/crowdlens.service /etc/systemd/system/crowdlens.service
sudo systemctl daemon-reload
sudo systemctl enable --now crowdlens
sudo systemctl status crowdlens --no-pager
```

Check that CDP is live:

```bash
curl -s http://127.0.0.1:9222/json/version
```

Expected shape:

```json
{
  "Browser": "Obscura/0.1.0"
}
```

## Query The Running Browser

Inspect the currently open page:

```bash
node /home/ubuntu/crowdlens/crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --inspect-current-page
```

Navigate to a direct place URL:

```bash
node /home/ubuntu/crowdlens/crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --url "https://www.google.com/maps/place/..."
```

Run a query:

```bash
node /home/ubuntu/crowdlens/crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --query "Costco Brooklyn NY"
```

## Runtime Notes

- Obscura can expose a weak snapshot immediately after navigation and then
  hydrate the useful Maps panel a few seconds later. The scraper first polls for
  popular-times signals, then falls back to a post-detach resample if needed.
- Tune that polling window with `--popular-times-wait-ms`; the default is
  `15000`.
- Fresh browser profiles can return Google's limited Maps view on the first
  navigation. The scraper retries one limited-view navigation by default.
- CloakBrowser remains available with `BROWSER_RUNTIME=cloak` if Obscura
  regresses, but it is Chromium-class in memory and disk footprint.
- Legacy Thorium remains available with `BROWSER_RUNTIME=thorium`.
