# CrowdLens Deployment

This is the lean production-shaped setup that worked best on a small Ubuntu VM:

- persistent `thorium-browser`
- one `Xvfb` display
- CDP bound to `127.0.0.1:9222`
- one reusable browser profile
- raw CDP scraper client in `crowdlens.mjs`

## Install

On Ubuntu:

```bash
sudo apt update
sudo apt install -y xvfb nodejs
node --version
```

Install Thorium Browser using the project's Ubuntu instructions, then verify:

```bash
which thorium-browser
which Xvfb
```

## Service Files

Copy these files into your server workspace:

- `crowdlens_service.sh`
- `crowdlens.service`
- `crowdlens.mjs`

Use Node `22.4.0+`. The raw-CDP client relies on Node's built-in `WebSocket`,
so no npm install step is required for the working path.

Make the launcher executable:

```bash
chmod +x /home/ubuntu/crowdlens/crowdlens_service.sh
```

The included unit file assumes your code lives at `/home/ubuntu/crowdlens`.
If it does not, update these fields in `crowdlens.service`:

- `WorkingDirectory`
- `ExecStart`
- `PROFILE_DIR`
- `LOG_DIR`

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

Run a query and follow the first place link when needed:

```bash
node /home/ubuntu/crowdlens/crowdlens.mjs \
  --cdp-url "http://127.0.0.1:9222" \
  --query "Costco Wholesale Yangjae"
```

## Runtime Notes

- The browser side is still the expensive part. Reusing one persistent instance
  is the main runtime win.
- The included launcher keeps the footprint conservative with low-end-device
  mode, disabled background features, and a small V8 old-space limit.
- If `64 MB` is unstable, raise `JS_OLD_SPACE_MB` in the service unit to `128`.
- If Google serves limited view for automated navigation, use a direct place URL
  or open the page manually and then run `--inspect-current-page`.
