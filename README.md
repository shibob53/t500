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

- **Datacenter IPs.** Tencent's anti-fraud often treats DC ranges (Railway,
  AWS, GCP) more strictly than residential IPs. The anonymous `/lookup`
  flow has held up so far on Railway; the **redeem flow on a DC IP is
  riskier** because:
  - The login itself may trigger a captcha for a first-time IP.
  - Even if login succeeds, sustained anti-fraud rules may rate-limit or
    flag the account.
  If `/switch` or `/coupon` start returning `invalid params` / empty / 4xx
  on Railway when they work locally, the DC IP is the likely cause and
  the fix is a residential proxy or running the daemon behind a tunnel
  (Cloudflare Tunnel) on a residential machine.
- **Anonymous session for `/lookup`.** A container without
  `MIDASBUY_EMAIL`/`MIDASBUY_PASSWORD` runs anonymously and only the
  `/lookup` endpoint works.
- **One browser per replica.** Calls are serialized through the page.
  Scale horizontally (multiple replicas) for throughput.
- **Token rotation.** The page handles its own 15-minute token rotation
  in-DOM; we read fresh tokens on every encrypt. Reactive re-prime kicks
  in if a response looks like an auth failure.
- **Login captcha.** If Tencent serves a captcha during programmatic
  login, the daemon will throw `login: modal did not close…`. Workarounds
  are to log in once locally with `init-login`, copy the resulting
  `.midasbuy-profile/` to the Railway volume, and start the daemon — it
  will pick up the cached cookies and skip programmatic login.
