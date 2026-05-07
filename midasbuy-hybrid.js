/**
 * Midasbuy Hybrid Automation — Playwright as encrypt oracle + raw HTTP
 *
 * One Playwright session, one UI-driven "prime" call to capture the live
 * getCharac plaintext, then any number of raw HTTPS calls that reuse that
 * plaintext with player_id swapped per request.
 *
 * Why not save the plaintext to disk? Every field in it (device_id, tdrc_fp,
 * pagetoken, expParams, hy_gameid) is bound to the live browser session and
 * is only assembled inside the bundle right before encryption — they're not
 * exposed on window globals or in storage in a usable form. So we capture
 * once per session and reuse only within that session.
 *
 * Re-priming: tokens rotate every 15 min (the 9e5 timer in
 * main.f8b.bundle.js), but the page itself drives that rotation and writes
 * the new ctoken into the DOM. encrypt() reads xMidasToken/xMidasVersion
 * fresh from the DOM on every call, and cookieHeader() re-reads cookies
 * from the context — so within a single Playwright session, tokens stay
 * fresh without us doing anything. We only re-prime *reactively*, when a
 * response looks like a token/auth failure that wasn't supposed to happen.
 *
 * Usage:
 *   node midasbuy-hybrid.js lookup <id1> [id2] [id3] ... [--visible]
 *   node midasbuy-hybrid.js serve  [--port=7777] [--prime=<id>] [--visible]
 *
 *     curl http://127.0.0.1:7777/lookup/<id>
 *     curl http://127.0.0.1:7777/health
 */

const { chromium } = require('playwright');
const http = require('http');

const TARGET_URL = 'https://www.midasbuy.com/midasbuy/eg/buy/pubgm?from=self.midasbuy_saas';
const API_BASE = 'https://www.midasbuy.com';
const ENDPOINT = '/interface/getCharac';

class MidasOracle {
  constructor(browser, context, page, opts = {}) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.captured = [];
    this.sessionTemplate = null;
    this.lastSamplePlayerId = null;
    this._captureExposed = false;
    this.onLog = opts.onLog || (() => {});
  }

  static async launch({ headless = true, onLog } = {}) {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });

    // Aegis checks navigator.webdriver (main.f8b.bundle.js around iu()/getCharac)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    return new MidasOracle(browser, context, page, { onLog });
  }

  async warmup() {
    await this._installCaptureBridge();
    await this._loadPage();
  }

  // exposeFunction errors on a second call with the same name, so we guard.
  // Stays valid across page navigations within the same context.
  async _installCaptureBridge() {
    if (this._captureExposed) return;
    await this.page.exposeFunction('__capturePlaintext', (s) => this.captured.push(s));
    this._captureExposed = true;
  }

  // Idempotent page setup: navigate, wait for tokens + form trigger, dismiss
  // overlays, (re-)hook xMidas. Safe to call again on re-prime.
  async _loadPage() {
    await this.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    await this.page.waitForFunction(() =>
      typeof window.xMidas === 'function' &&
      !!document.getElementById('xMidasToken')?.value &&
      !!document.getElementById('xMidasVersion')?.value,
    { timeout: 30000 });

    await this.page.locator('[class*="UserTabBox"]').first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});

    await this.dismissOverlays();

    await this.page.evaluate(() => {
      if (window.__xMidasOriginal) return;
      window.__xMidasOriginal = window.xMidas;
      window.xMidas = function (arg) {
        try { if (arg && typeof arg.d === 'string') window.__capturePlaintext(arg.d); } catch (_) {}
        return window.__xMidasOriginal.apply(this, arguments);
      };
    });
  }

  async _waitForVisibleInput(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const els = this.page.locator(selector);
      const count = await els.count();
      for (let i = 0; i < count; i++) {
        const el = els.nth(i);
        if (await el.isVisible().catch(() => false)) {
          const inViewport = await el.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).catch(() => false);
          if (inViewport) return el;
        }
      }
      await this.page.waitForTimeout(250);
    }
    throw new Error(`no visible element matched ${selector} within ${timeoutMs}ms`);
  }

  async dismissOverlays() {
    try {
      const ad = this.page.locator('[class*="PatFacePopWrapper"] [class*="close"]').first();
      if (await ad.isVisible({ timeout: 3000 })) await ad.click({ force: true });
    } catch (_) {}
    // Hide rather than remove — removing detaches listeners the page reuses.
    await this.page.evaluate(() => {
      ['PatFacePopWrapper', 'PopCookie'].forEach((c) => {
        document.querySelectorAll(`[class*="${c}"]`).forEach((el) => {
          el.style.display = 'none';
          el.style.pointerEvents = 'none';
        });
      });
    });
  }

  async encrypt(plaintext) {
    return this.page.evaluate((s) => {
      const hex = window.__xMidasOriginal({ d: s });
      if (!hex) return null;
      const bytes = (hex.match(/../g) || []).map((h) => parseInt(h, 16));
      return {
        encrypt_msg: btoa(String.fromCharCode(...bytes)),
        ctoken_ver: document.getElementById('xMidasVersion').value,
        ctoken: document.getElementById('xMidasToken').value,
      };
    }, plaintext);
  }

  async cookieHeader() {
    const cookies = await this.context.cookies(API_BASE);
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  async rawPost(plaintext) {
    const body = await this.encrypt(plaintext);
    if (!body) throw new Error('encrypt() returned null — xMidas refused');
    const cookie = await this.cookieHeader();
    const ua = await this.page.evaluate(() => navigator.userAgent);

    const res = await fetch(`${API_BASE}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Cookie: cookie,
        'User-Agent': ua,
        Origin: API_BASE,
        Referer: TARGET_URL,
      },
      body: JSON.stringify(body),
    });

    let data;
    try { data = await res.json(); } catch (_) { data = await res.text(); }
    return { status: res.status, data };
  }

  /**
   * Drive the UI once with samplePlayerId so the bundle assembles a real
   * getCharac plaintext into our hook. The first lookup is paid for here;
   * subsequent ones in this session reuse the captured plaintext.
   */
  async prime(samplePlayerId) {
    // Two states: fresh visit shows the "enter player ID" trigger
    // (UserTabBox_use_tab_box). Returning visit (page restored a linked
    // player) shows the player info card with a small switch-icon button
    // (UserTabBox_switch_btn) — clicking that reopens the form.
    const switchBtn = this.page.locator('[class*="UserTabBox_switch_btn"]').first();
    const useTabTrigger = this.page.locator('[class*="UserTabBox_use_tab_box"]').first();

    if (await switchBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await switchBtn.click({ force: true });
    } else {
      await useTabTrigger.waitFor({ state: 'visible', timeout: 15000 });
      await useTabTrigger.click({ force: true });
      await this.page.waitForTimeout(500);
      if (await useTabTrigger.isVisible({ timeout: 2000 }).catch(() => false)) {
        await useTabTrigger.click({ force: true });
      }
    }

    // The page caches form state across reloads, so multiple inputs with the
    // same placeholder can exist (one in a hidden previous-session container,
    // one in the active popup). Poll for a truly visible one rather than
    // force-clicking the first match.
    const input = await this._waitForVisibleInput('input[placeholder*="معرف لاعب"]', 10000);
    await input.click({ force: true });
    await input.fill('');
    await input.type(String(samplePlayerId), { delay: 20 });

    this.captured.length = 0;

    const respPromise = this.page
      .waitForResponse((r) => r.url().includes(ENDPOINT), { timeout: 20000 })
      .catch(() => null);

    const okBtn = this.page.locator('[class*="Button_btn_wrap"]').filter({ hasText: /^OK$/i }).first();
    if (await okBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await okBtn.click({ force: true });
    } else {
      await this.page.keyboard.press('Enter');
    }

    const resp = await respPromise;
    await this.page.waitForTimeout(300);

    const plaintext = pickGetCharacPlaintext(this.captured, String(samplePlayerId));
    if (!plaintext) throw new Error('prime: no getCharac plaintext captured');

    this.sessionTemplate = { plaintext, samplePlayerId: String(samplePlayerId) };
    this.lastSamplePlayerId = String(samplePlayerId);

    let data = null;
    if (resp) { try { data = await resp.json(); } catch (_) {} }
    return { status: resp ? resp.status() : null, data, primedWith: String(samplePlayerId) };
  }

  async _reprime() {
    if (!this.lastSamplePlayerId) throw new Error('cannot re-prime: no sample player ID retained');
    this.onLog('reprime');
    // page.reload() preserves URL + history and tends to land in a cleaner
    // SPA state than a full goto() (the bundle's restored state can leave
    // the form trigger in a non-clickable variant on goto).
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(() =>
      typeof window.xMidas === 'function' &&
      !!document.getElementById('xMidasToken')?.value &&
      !!document.getElementById('xMidasVersion')?.value,
    { timeout: 30000 });
    await this.page.locator('[class*="UserTabBox"]').first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});
    await this.dismissOverlays();
    await this.page.evaluate(() => {
      if (window.__xMidasOriginal) return;
      window.__xMidasOriginal = window.xMidas;
      window.xMidas = function (arg) {
        try { if (arg && typeof arg.d === 'string') window.__capturePlaintext(arg.d); } catch (_) {}
        return window.__xMidasOriginal.apply(this, arguments);
      };
    });
    return this.prime(this.lastSamplePlayerId);
  }

  /**
   * /interface/getCharac is itself the resolver: input top-level `openid` =
   * typed player_id, empty pagetoken trailing. Response carries the real openid
   * and character name. So per-lookup we just swap top-level `openid` and
   * refresh `_id`; the endpoint does the resolution for us.
   *
   * Reactively re-primes once if the response looks like a token/auth error.
   */
  async lookup(playerId) {
    if (!this.sessionTemplate) throw new Error('lookup: call prime() first');

    const send = () => {
      const obj = JSON.parse(this.sessionTemplate.plaintext);
      obj.openid = String(playerId);
      if ('_id' in obj) obj._id = String(Math.random());
      return this.rawPost(JSON.stringify(obj));
    };

    let res = await send();
    if (looksLikeTokenError(res)) {
      try {
        await this._reprime();
        res = await send();
      } catch (err) {
        this.onLog('reprime-failed:' + (err.message || err));
        // Return the original token-error response rather than masking it.
      }
    }
    return res;
  }

  async close() {
    await this.browser.close();
  }
}

/**
 * Find the plaintext that was sent to /interface/getCharac. Schema:
 * top-level `openid` = the typed player_id, with no `data` block. Several
 * other large plaintexts are captured in the same window (downstream activity
 * calls); they have a `data.mp_task_meta_data` block instead and target
 * different endpoints — we explicitly skip those.
 */
function pickGetCharacPlaintext(captured, samplePlayerId) {
  for (const p of captured) {
    let o; try { o = JSON.parse(p); } catch (_) { continue; }
    if (o && typeof o === 'object' && o.openid === samplePlayerId && !o.data) return p;
  }
  return null;
}

/**
 * Distinguish auth/token failures from legitimate "player not found".
 * A successful resolve is { ret: 0, info: {...} }. A real not-found is
 * { ret: 1, err_code: 1, msg: "load role X data err" }. Anything else
 * (HTTP error, "invalid params", "ctoken expired", etc.) is treated as
 * token rot and triggers a re-prime + retry.
 */
function looksLikeTokenError(res) {
  if (!res || res.status !== 200) return true;
  const d = res.data;
  if (!d || typeof d !== 'object') return false;
  if (d.ret === 0) return false;
  const msg = String(d.msg || '');
  if (d.err_code === 1 && /load role/i.test(msg)) return false;
  return true;
}

function fmt(data) {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

// Serial promise queue. One Playwright page can't safely run two encrypt()
// calls in parallel (they read tokens from the same DOM and mutate the
// captured array), so we serialize HTTP handlers through this.
function makeQueue() {
  let chain = Promise.resolve();
  return (fn) => {
    const p = chain.then(fn, fn);
    chain = p.then(() => {}, () => {});
    return p;
  };
}

async function cmdLookup({ ids, visible }) {
  const oracle = await MidasOracle.launch({
    headless: !visible,
    onLog: (event) => { if (event === 'reprime') console.log('    [re-priming session — token rotation detected]'); },
  });
  try {
    console.log('[1] Warming oracle...');
    const t0 = Date.now();
    await oracle.warmup();
    console.log(`    OK (${Date.now() - t0}ms)`);

    console.log(`[2] Priming via UI with ${ids[0]}...`);
    const t1 = Date.now();
    const primed = await oracle.prime(ids[0]);
    console.log(`    OK (${Date.now() - t1}ms) — HTTP ${primed.status}`);
    console.log('');
    console.log(`[+] ${ids[0]}:`);
    console.log(fmt(primed.data));

    for (let i = 1; i < ids.length; i++) {
      const id = ids[i];
      console.log('');
      console.log(`[${i + 2}] Raw POST for ${id}...`);
      const t = Date.now();
      const res = await oracle.lookup(id);
      console.log(`    ${Date.now() - t}ms — HTTP ${res.status}`);
      console.log(`[+] ${id}:`);
      console.log(fmt(res.data));
    }
  } finally {
    await oracle.close();
  }
}

async function cmdServe({ port, visible, primeWith }) {
  // When PORT is set by the host (Railway, Fly, Heroku, etc.) we bind to
  // all interfaces; otherwise stay on loopback so a local dev daemon isn't
  // exposed on the LAN by accident.
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  const bindHost = envPort ? '0.0.0.0' : '127.0.0.1';
  const bindPort = envPort || port;

  // Bearer-token auth, opt-in via env var. Set AUTH_TOKEN on the host to
  // require Authorization: Bearer <token> on every request.
  const authToken = process.env.AUTH_TOKEN || null;
  const oracle = await MidasOracle.launch({
    headless: !visible,
    onLog: (event) => {
      if (event === 'reprime') console.log('[oracle] re-priming (token rotation / auth error)');
      else if (typeof event === 'string' && event.startsWith('reprime-failed:')) console.log('[oracle] ' + event);
    },
  });

  console.log('[1] Warming oracle...');
  const t0 = Date.now();
  await oracle.warmup();
  console.log(`    OK (${Date.now() - t0}ms)`);

  if (primeWith) {
    console.log(`[2] Priming with ${primeWith}...`);
    const t1 = Date.now();
    const primed = await oracle.prime(primeWith);
    console.log(`    OK (${Date.now() - t1}ms) — ${primed.data?.info?.charac_name || primed.data?.msg || 'no info'}`);
  } else {
    console.log('[2] Lazy prime — first /lookup request will pay the UI cost (~5s)');
  }

  const queue = makeQueue();

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };

  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch (_) { return send(400, { error: 'bad request' }); }

    // /health is always reachable; everything else requires the bearer
    // token if AUTH_TOKEN is set.
    if (url.pathname === '/health') {
      return send(200, { ok: true, primed: oracle.sessionTemplate !== null });
    }

    if (authToken) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (got !== authToken) return send(401, { error: 'unauthorized' });
    }

    const m = url.pathname.match(/^\/lookup\/(\d+)$/);
    if (!m) return send(404, { error: 'not found' });
    const id = m[1];

    queue(async () => {
      const t = Date.now();
      const r = oracle.sessionTemplate
        ? await oracle.lookup(id)
        : await oracle.prime(id);
      return { httpStatus: r.status || 200, body: r.data, ms: Date.now() - t };
    }).then(
      (r) => {
        console.log(`[lookup] ${id} → HTTP ${r.httpStatus} (${r.ms}ms) ${r.body?.info?.charac_name || r.body?.msg || ''}`);
        send(r.httpStatus, r.body);
      },
      (err) => {
        console.error(`[lookup] ${id} → error: ${err.message || err}`);
        send(500, { error: String(err.message || err) });
      },
    );
  });

  server.listen(bindPort, bindHost, () => {
    console.log('');
    console.log(`[3] Listening on http://${bindHost}:${bindPort}`);
    console.log(`    curl http://${bindHost}:${bindPort}/lookup/<id>`);
    console.log(`    curl http://${bindHost}:${bindPort}/health`);
    if (authToken) console.log('    auth: Authorization: Bearer <AUTH_TOKEN>  (required)');
    else console.log('    auth: none (set AUTH_TOKEN env var to require a bearer token)');
    console.log('');
    console.log('    Ctrl+C to shut down.');
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[+] ${sig} — closing browser...`);
    server.close();
    try { await oracle.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printUsage() {
  console.log('Usage:');
  console.log('  node midasbuy-hybrid.js lookup <id1> [id2] ... [--visible]');
  console.log('  node midasbuy-hybrid.js serve  [--port=7777] [--prime=<id>] [--visible]');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const visible = args.includes('--visible');

  if (cmd === 'serve') {
    const portArg = args.find((a) => /^--port=\d+$/.test(a));
    const port = portArg ? parseInt(portArg.split('=')[1], 10) : 7777;
    const primeArg = args.find((a) => /^--prime=\d+$/.test(a));
    const primeWith = primeArg ? primeArg.split('=')[1] : (process.env.PRIME_ID || null);
    return cmdServe({ port, visible, primeWith });
  }

  if (cmd === 'lookup') {
    const ids = args.slice(1).filter((a) => /^\d+$/.test(a));
    if (ids.length === 0) { printUsage(); process.exit(1); }
    return cmdLookup({ ids, visible });
  }

  printUsage();
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => { console.error('[!] ' + (e.stack || e.message || e)); process.exit(1); });
}

module.exports = { MidasOracle };
