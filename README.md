# midasbuy-hybrid

Hybrid Midasbuy player-ID lookup. One headless Playwright session acts as an
in-process encryption oracle for Tencent's `xMidas` (CHAOS-VM AES); every
lookup goes out as a raw HTTPS POST that reuses the live session's cookies,
fingerprint, and rotating tokens. First call pays a ~5 s warmup + UI prime;
every call after is bounded by Tencent's own latency (~400–500 ms).

## Endpoints

```
GET /lookup/<player_id>   → { ret, info: { openid, charac_name, ... } }
GET /health               → { ok, primed }
```

If `AUTH_TOKEN` is set, every request except `/health` requires
`Authorization: Bearer <AUTH_TOKEN>`.

## Local dev

```bash
npm install
npx playwright install chromium

# CLI mode (one-shot lookups, spawns its own browser):
node midasbuy-hybrid.js lookup 5234567890 558565587

# Daemon mode (long-lived browser, raw-HTTP per call):
node midasbuy-hybrid.js serve --prime=5234567890
curl http://127.0.0.1:7777/lookup/558565587
```

## Deploy on Railway

1. Connect this repo to a new Railway service.
2. Railway auto-detects the `Dockerfile` and builds it (Playwright's official
   image is used, so Chromium + system deps come baked in).
3. Set environment variables:
   - `AUTH_TOKEN` — long random string. Required header: `Authorization: Bearer <token>`.
   - `PRIME_ID` *(optional)* — a real PUBGM player ID to pre-prime on boot.
     Without it the first request to `/lookup/X` pays the prime cost.
4. Railway sets `PORT` automatically; the script binds to `0.0.0.0:$PORT` when
   `PORT` is present, otherwise to `127.0.0.1:7777`.

## Known limits

- **Datacenter IPs.** Tencent's anti-fraud may treat requests from cloud DC
  ranges (Railway, AWS, GCP) more strictly than residential IPs. If responses
  start coming back as `invalid params` or empty, that's the likely cause.
- **Anonymous session.** A fresh container starts with no Midasbuy login
  cookies. The `/interface/getCharac` resolver appears to be callable
  anonymously, but if you ever see auth-shaped failures, this is why.
- **One browser per replica.** Calls are serialized through the page. Scale
  horizontally (multiple replicas) for higher throughput, not multiple
  pages in one process.
- **Token rotation.** The page handles its own 15-minute token rotation
  in-DOM; we read fresh tokens on every encrypt. Reactive re-prime kicks in
  if a response looks like an auth failure.
