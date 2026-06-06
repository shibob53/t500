# midasbuy-hybrid

Hybrid Midasbuy automation. One headless Playwright session acts as an
in-process encryption oracle for Tencent's `xMidas` (CHAOS-VM AES); every
operation goes out as a raw HTTPS POST that reuses the live session's
cookies, fingerprint, and rotating tokens. First call pays a one-time UI
prime (~5 s); every call after is bounded by Tencent's own latency (~400–500 ms).

## Endpoints

```
GET /lookup/<player_id>   → { ret, info: { openid, charac_name, ... } }       (anonymous)
GET /switch/<player_id>   → { ret, info: { ... } }                            (requires login)
GET /coupon/<code>        → { ret, msg, err_code, ... }                       (requires login)
GET /health               → { ok, primed: { lookup, switch, coupon } }
```

If `AUTH_TOKEN` is set, every request except `/health` requires
`Authorization: Bearer <AUTH_TOKEN>`.

## Local dev

**On Windows**, just double-click `init-login.bat` once (sign in by hand,
close), then double-click `start-daemon.bat` whenever you want the
daemon up. Both scripts auto-install Node deps + Chromium on first run
and skip on subsequent runs.

**On Linux** (Mint/Ubuntu/Debian), the equivalent helper scripts are
`init-login.sh` and `start-daemon.sh`. After cloning:
```bash
chmod +x init-login.sh start-daemon.sh
./init-login.sh           # one-time, opens visible browser to log in
./start-daemon.sh         # run the daemon in the foreground
```
For true always-on behavior (auto-start at boot, restart on crash) on a
dedicated Linux host, skip the .sh scripts and use a systemd unit
instead — see "Linux always-on host" below.

### Linux always-on host (systemd)

```bash
sudo nano /etc/systemd/system/midasbuy-daemon.service
```
Paste, replacing `charaf` with your username and the node path with
`$(which node)` output:
```ini
[Unit]
Description=Midasbuy Hybrid Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=charaf
WorkingDirectory=/home/charaf/midasbuy-hybrid
ExecStart=/usr/bin/node /home/charaf/midasbuy-hybrid/midasbuy-hybrid.js serve
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
```
Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now midasbuy-daemon
journalctl -u midasbuy-daemon -f          # live logs
```
Disable system suspend so the always-on PC actually stays on:
```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

For the manual flow (any OS):

```bash
npm install
npx playwright install chromium

# Anonymous lookup, no login needed:
node midasbuy-hybrid.js lookup 5234567890 558565587

# Login once interactively (opens visible browser, you log in by hand,
# cookies persist in .midasbuy-profile/):
node midasbuy-hybrid.js init-login

# After login: redeem-flow operations work too
node midasbuy-hybrid.js switch 5234567890
node midasbuy-hybrid.js coupon AAAAAAAAAA
node midasbuy-hybrid.js pipe   5234567890 AAAAAAAAAA   # switch + validate in one session

# Daemon mode (long-lived browser, raw HTTP per call):
node midasbuy-hybrid.js serve --prime=5234567890
curl http://127.0.0.1:7777/lookup/558565587
```

## Deploy on Railway

The anonymous `/lookup` endpoint works out of the box. The redeem-flow
endpoints (`/switch`, `/coupon`) need a logged-in session; the container
can't open a visible browser for `init-login`, so we use **programmatic
login**: set credentials as env vars and the daemon logs itself in on
startup, then persists the cookies in a Railway volume.

1. Connect this repo to a new Railway service. Railway auto-detects the
   `Dockerfile` and builds it (Playwright's official image baked with
   Chromium + system deps).
2. **Variables:**
   - `AUTH_TOKEN` — long random string. Required header on protected
     endpoints: `Authorization: Bearer <token>`.
   - `MIDASBUY_EMAIL` — your Midasbuy login email.
   - `MIDASBUY_PASSWORD` — your Midasbuy password.
   - `PRIME_ID` *(optional)* — a real PUBGM player ID to pre-prime
     `/lookup` on boot.
3. **Volume:** add a persistent volume mounted at `/app/.midasbuy-profile`.
   This is where Playwright stores cookies + storage. Without it, every
   restart re-runs the programmatic login from scratch (and may trip
   Tencent's anti-fraud).
4. Railway sets `PORT` automatically; the script binds to `0.0.0.0:$PORT`
   when `PORT` is present, otherwise `127.0.0.1:7777`.

On first boot the daemon logs in via the form, persists cookies, and
serves. Subsequent restarts skip login (cached in the volume) until the
session expires.

## Known limits

- **`/coupon` (and any future `/redeem`) is geo-fenced.** Tencent's
  recharge/redeem flow is region-locked at the edge: the page
  `/midasbuy/<country>/redeem/pubgm` only serves clients whose IP
  matches the country segment. Tested deploy from a Netherlands Railway
  region against `/eg/redeem`: the page renders an `انتباه` ("notice")
  modal saying *"the recharge service on this site doesn't support your
  region, we'll redirect you to..."* — there's no way around it short
  of routing through a residential IP in your actual region. **Therefore
  the redeem-flow endpoints (`/switch` and `/coupon`) are intended to
  run on a local/residential machine, not in a cloud DC.** The Railway
  deploy here is `/lookup`-only.
- **`/lookup` is region-agnostic** because it only calls
  `/interface/getCharac` (a player resolver), which Tencent doesn't
  geo-fence. That deploy survives on Railway.
- **One browser per replica.** Calls are serialized through the page.
  Scale horizontally (multiple replicas) for throughput.
- **Token rotation.** The page handles its own 15-minute token rotation
  in-DOM; we read fresh tokens on every encrypt. Reactive re-prime kicks
  in if a response looks like an auth failure.
- **Login captcha.** If you do try to host the redeem flow somewhere
  with credentials and Tencent serves a captcha, the daemon throws
  `login: modal did not close…` or `could not surface login modal`. The
  fallback is to log in once locally with `init-login` and copy the
  resulting `.midasbuy-profile/` to the host's volume so the daemon
  starts already-logged-in. (Even with cached cookies, the regional
  block still applies — see first bullet.)
# t500
