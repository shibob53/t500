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
 *   node midasbuy-hybrid.js lookup         <id1> [id2] ... [--visible]
 *   node midasbuy-hybrid.js serve          [--port=7777] [--prime=<id>] [--visible]
 *   node midasbuy-hybrid.js init-login     (one-time, opens browser to log in)
 *   node midasbuy-hybrid.js capture-redeem (drives a real coupon redemption to learn its schema)
 *
 *     curl http://127.0.0.1:7777/lookup/<id>
 *     curl http://127.0.0.1:7777/health
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Country-keyed URL builders. Default 'eg' preserves the previous behavior.
// Pages live at /midasbuy/<country>/buy/pubgm and /midasbuy/<country>/redeem/pubgm.
const DEFAULT_COUNTRY = 'eg';
const buildTargetUrl = (c = DEFAULT_COUNTRY) => `https://www.midasbuy.com/midasbuy/${c.toLowerCase()}/buy/pubgm?from=self.midasbuy_saas`;
const buildRedeemUrl = (c = DEFAULT_COUNTRY) => `https://www.midasbuy.com/midasbuy/${c.toLowerCase()}/redeem/pubgm`;
// Back-compat aliases for places that don't have a country-aware oracle yet
// (init-login, capture-* commands). They default to 'eg' but accept overrides.
const TARGET_URL = buildTargetUrl();
const REDEEM_URL = buildRedeemUrl();
const API_BASE = 'https://www.midasbuy.com';
const ENDPOINT = '/interface/getCharac';
const REDEEM_ENDPOINT = '/interface/shelfProto/shelves_svr/QueryRedeemCodeInfo';
const ARSAL_ENDPOINT = '/h5/overseah5/views/os_midaspay_v2/index.html';
const PROFILE_DIR = path.join(__dirname, '.midasbuy-profile');

/**
 * Resolve proxy configuration from environment variables.
 * Per-country: PROXY_EG, PROXY_EG_USER, PROXY_EG_PASS
 * Global fallback: PROXY_URL, PROXY_USER, PROXY_PASS
 */
function resolveProxyConfig(country) {
  const c = (country || '').toUpperCase();
  const url = process.env[`PROXY_${c}`] || process.env.PROXY_URL;
  if (!url) return null;
  return {
    server: url,
    username: process.env[`PROXY_${c}_USER`] || process.env.PROXY_USER || '',
    password: process.env[`PROXY_${c}_PASS`] || process.env.PROXY_PASS || '',
  };
}

class MidasOracle {
  constructor(browser, context, page, opts = {}) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.captured = [];
    // Country drives which Midasbuy region pages we use (eg, sa, de, …).
    // Templates are tied to the country we primed them on, so changing
    // country invalidates them — setCountry() wipes the region-specific ones.
    this.country = (opts.forceCountry || DEFAULT_COUNTRY).toLowerCase();
    this.sessionTemplate = null;       // primed plaintext for /interface/getCharac (buy page, buyType=SAVE)
    this.redeemTemplate = null;        // primed plaintext for QueryRedeemCodeInfo
    this.switchTemplate = null;        // primed plaintext for /interface/getCharac (redeem page, buyType=redeem)
    this.arsalTemplate = null;         // primed form body for the ارسال consume POST
    this.lastSamplePlayerId = null;
    this._captureExposed = false;
    this.onLog = opts.onLog || (() => {});
    this.forceCountry = opts.forceCountry || null;

    // Proxy support: undici ProxyAgent dispatcher for raw fetch() calls.
    this._proxyConfig = opts.proxy || null;
    this._dispatcher = undefined;
    if (this._proxyConfig) {
      try {
        const { ProxyAgent } = require('undici');
        const server = this._proxyConfig.server.replace(/^https?:\/\//, '');
        const proxyUrl = this._proxyConfig.username
          ? `http://${this._proxyConfig.username}:${this._proxyConfig.password}@${server}`
          : this._proxyConfig.server;
        this._dispatcher = new ProxyAgent(proxyUrl);
      } catch (e) {
        console.warn('[proxy] undici ProxyAgent unavailable, raw fetch() will NOT use proxy:', e.message);
      }
    }
  }

  // Uses a persistent context so cookies/storage from a manual login
  // (init-login) survive across runs. Profile dir is gitignored.
  static async launch({ headless = true, onLog, proxy, forceCountry } = {}) {
    // Virtual display: run browser "headed" (bypasses Aegis headless detection)
    // but render to Xvfb — no real GPU/window overhead on the host.
    // Requires: sudo apt install xvfb  (or yum install xorg-x11-server-Xvfb)
    // Auto-activates when not using --visible. Falls back to regular headless.
    if (headless) {
      try {
        const { spawn } = require('child_process');
        const display = ':' + (99 + Math.floor(Math.random() * 100));
        const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
          stdio: 'ignore', detached: true,
        });
        xvfb.unref();
        // Brief wait for Xvfb to bind the display
        await new Promise((r) => setTimeout(r, 300));
        process.env.DISPLAY = display;
        headless = false;
        console.log(`[xvfb] Virtual display on ${display} — headed mode without real screen`);
      } catch (_) {
        console.log('[xvfb] Xvfb not available, falling back to headless mode');
      }
    }

    const launchOpts = {
      headless,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    };
    if (proxy) {
      launchOpts.proxy = {
        server: proxy.server,
        ...(proxy.username ? { username: proxy.username, password: proxy.password } : {}),
      };
      console.log(`[proxy] Playwright browser routing through ${proxy.server}`);
    }
    const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);

    // Aegis checks navigator.webdriver (main.f8b.bundle.js around iu()/getCharac)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Note: the xMidas hook is installed *after* page scripts finish loading
    // (via the manual evaluate() blocks in _loadPage / primeSwitch /
    // primeRedeem / _reprime), NOT here via addInitScript. Installing it
    // pre-script-load via Object.defineProperty(get/set) on window.xMidas
    // creates an inspectable property descriptor anomaly that Aegis flags
    // during its fingerprint pass — Tencent then treats the session as
    // untrusted and serves a logged-out UI (disabled inputs) even with
    // valid cookies. Late-binding the hook keeps the property a normal
    // value so Aegis can't see it.

    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(20000);
    return new MidasOracle(null, context, page, { onLog, proxy, forceCountry });
  }

  async warmup() {
    await this._installCaptureBridge();
    await this._loadPage();
  }

  /**
   * If a validation/redeem-info response carries playerCountryCode that
   * differs from the daemon's current country, auto-switch to the player's
   * country. Returns the new country if it changed, null otherwise.
   * Caller is responsible for re-doing any switch/prime work on the new
   * region (setCountry wipes the redeem-flow templates).
   */
  async _maybeAutoSwitchCountry(validationData) {
    const playerCountry = String(validationData?.playerCountryCode || '').toLowerCase();
    if (!playerCountry) return null;
    if (playerCountry === this.country) return null;
    if (this.forceCountry) {
      console.log(`[auto-country] BLOCKED by --force-country=${this.forceCountry}: server says ${playerCountry}, staying on ${this.country}`);
      return null;
    }
    this.onLog(`auto-country:${this.country}->${playerCountry}`);
    console.log(`[auto-country] ${this.country} → ${playerCountry} (per playerCountryCode in validation response)`);
    await this.setCountry(playerCountry);
    return playerCountry;
  }

  /**
   * Switch the active region. Templates are region-specific (the form bodies
   * have country/currency/region-locked fields), so changing country wipes
   * the redeem-flow templates so they re-prime against the new region next
   * time they're used. The buy-page sessionTemplate stays — /lookup is
   * anonymous and effectively region-agnostic.
   */
  async setCountry(country) {
    const next = String(country || DEFAULT_COUNTRY).toLowerCase();
    if (this.country === next) return;
    this.country = next;
    this.switchTemplate = null;
    this.redeemTemplate = null;
    this.arsalTemplate = null;
    this.lastSamplePlayerId = null;

    // Persuade Tencent's edge to stop redirecting our navigations back to
    // the account's "home" region. Two cookies drive this:
    //   select_country=<iso2>  – the user's chosen Midasbuy locale
    //   select_cookie=1        – the "cookie consent / locale stored" flag
    // Without these, /<other-region>/redeem 302s back to /eg/redeem (or
    // wherever the account is registered), and our country-switch becomes
    // theatre. This makes the navigation stick.
    try {
      const expires = Math.floor(Date.now() / 1000) + 86400 * 365;
      await this.context.addCookies([
        { name: 'select_country', value: next, domain: '.midasbuy.com', path: '/', expires },
        { name: 'select_cookie',  value: '1',  domain: '.midasbuy.com', path: '/', expires },
      ]);
    } catch (_) {}
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
    await this.page.goto(buildTargetUrl(this.country), { waitUntil: 'domcontentloaded' });

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

  // Fast version — no waiting, just nuke ad/cookie/VIP popups (NOT redeem dialogs)
  async _fastDismissOverlays() {
    await this.page.evaluate(() => {
      const safeToHide = /PatFace|PopCookie|PopVip|PopGift|PopMarketing/i;
      document.querySelectorAll('[class*="Pop"], [class*="PatFace"]').forEach((el) => {
        if (safeToHide.test(el.className)) {
          el.style.display = 'none';
          el.style.pointerEvents = 'none';
        }
      });
    }).catch(() => {});
  }

  async dismissOverlays() {
    try {
      const ad = this.page.locator('[class*="PatFacePopWrapper"] [class*="close"]').first();
      if (await ad.isVisible({ timeout: 3000 })) await ad.click({ force: true });
    } catch (_) {}
    // Hide rather than remove — removing detaches listeners the page reuses.
    // Catch any class that looks like a Pop*Wrapper / Pop*Box modal.
    await this.page.evaluate(() => {
      const looksLikePopup = (cls) =>
        typeof cls === 'string' && /\bPop[A-Z]\w*/.test(cls);
      document.querySelectorAll('[class*="Pop"]').forEach((el) => {
        if (looksLikePopup(el.className)) {
          el.style.display = 'none';
          el.style.pointerEvents = 'none';
        }
      });
      ['PopCookie'].forEach((c) => {
        document.querySelectorAll(`[class*="${c}"]`).forEach((el) => {
          el.style.display = 'none';
          el.style.pointerEvents = 'none';
        });
      });
    });
  }

  async encrypt(plaintext) {
    return this.page.evaluate((s) => {
      // The hook lives on `window` and is wiped on navigation. If we got here
      // after a navigation that nobody re-hooked (e.g. login redirect, form
      // submit response), install it just-in-time. Capture is irrelevant for
      // a direct encrypt — we only need __xMidasOriginal to call.
      if (typeof window.__xMidasOriginal !== 'function') {
        if (typeof window.xMidas !== 'function') return null;
        window.__xMidasOriginal = window.xMidas;
        window.xMidas = function (arg) {
          try {
            if (arg && typeof arg.d === 'string' && typeof window.__capturePlaintext === 'function') {
              window.__capturePlaintext(arg.d);
            }
          } catch (_) {}
          return window.__xMidasOriginal.apply(this, arguments);
        };
      }
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

  async rawPost(plaintext, { endpoint = ENDPOINT, referer = null } = {}) {
    if (!referer) referer = buildTargetUrl(this.country);
    const body = await this.encrypt(plaintext);
    if (!body) throw new Error('encrypt() returned null — xMidas refused');
    const cookie = await this.cookieHeader();
    const ua = await this.page.evaluate(() => navigator.userAgent);

    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Cookie: cookie,
        'User-Agent': ua,
        Origin: API_BASE,
        Referer: referer,
      },
      body: JSON.stringify(body),
      ...(this._dispatcher ? { dispatcher: this._dispatcher } : {}),
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
    await this._installCaptureBridge();

    // After login or other operations the page may be on /redeem; prime()
    // needs the buy form. Navigate explicitly and reinstall the hook on
    // the fresh page so xMidas captures the upcoming form's plaintext.
    if (!this.page.url().includes('/buy/pubgm')) {
      await this.page.goto(buildTargetUrl(this.country), { waitUntil: 'domcontentloaded' });
      await this.page.waitForFunction(() =>
        typeof window.xMidas === 'function' &&
        !!document.getElementById('xMidasToken')?.value &&
        !!document.getElementById('xMidasVersion')?.value,
      { timeout: 30000 });
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

  /**
   * Drive the redeem-page form once with sampleCoupon so the bundle assembles
   * a real QueryRedeemCodeInfo plaintext. Same idea as prime() for getCharac:
   * the first call pays the UI cost, subsequent validateCoupon() calls reuse
   * the captured plaintext with redeem_code swapped per request.
   *
   * NOTE: the captured plaintext has direct_redeem:"1". Whether this means
   * "validation only" or "validate+consume" is unverified — the user's manual
   * test of clicking OK suggested validation-only, but no guarantee.
   */
  async primeRedeem(sampleCoupon) {
    await this._installCaptureBridge();

    if (!this.page.url().includes('/redeem/pubgm')) {
      await this.page.goto(buildRedeemUrl(this.country), { waitUntil: 'domcontentloaded' });
      await this.page.waitForFunction(() =>
        typeof window.xMidas === 'function' &&
        !!document.getElementById('xMidasToken')?.value,
      { timeout: 30000 });
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

    // The redeem form's coupon input — try a few placeholder/class fallbacks.
    const inputSelectors = [
      'input[placeholder*="رمز"]',           // Arabic for "code"
      'input[placeholder*="Redeem" i]',
      'input[placeholder*="Coupon" i]',
      'input[placeholder*="Code" i]',
      'input[class*="redeem" i]',
      'input[class*="coupon" i]',
    ];
    let input = null;
    let usedInputSelector = null;
    for (const sel of inputSelectors) {
      try {
        input = await this._waitForVisibleInput(sel, 1500);
        usedInputSelector = sel;
        break;
      } catch (_) {}
    }
    if (!input) {
      await this._dumpRedeemDom('no-input');
      throw new Error('primeRedeem: no visible coupon input found. DOM dump above — paste it for selector fix.');
    }

    await input.click({ force: true });
    await input.fill('');
    await input.type(String(sampleCoupon), { delay: 0 });

    // Re-dismiss any popup that appeared since page load (the redeem page
    // shows VIP gift / status prompts that intercept clicks otherwise).
    await this.dismissOverlays();

    this.captured.length = 0;

    const respPromise = this.page
      .waitForResponse((r) => r.url().includes('QueryRedeemCodeInfo'), { timeout: 60000 })
      .catch(() => null);

    // Most specific first: the redeem form's own OK button.
    const okBtn = this.page.locator('[class*="RedeemStepBox_btn_wrap"]')
      .filter({ hasText: /^OK$/i }).first();
    let clicked = false;
    if (await okBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await okBtn.click({ force: true }).catch(() => {});
      clicked = true;
      console.log('[primeRedeem] clicked: RedeemStepBox_btn_wrap');
    } else {
      // Fallback: any non-disabled Button_btn_wrap with OK text. Skip ones
      // whose className includes " false" (those are React-disabled).
      const candidates = this.page.locator('[class*="Button_btn_wrap"]').filter({ hasText: /^OK$/i });
      const n = await candidates.count();
      for (let i = 0; i < n; i++) {
        const c = candidates.nth(i);
        const cls = await c.getAttribute('class').catch(() => '');
        if (cls && /\bfalse\b/.test(cls)) continue;
        if (!await c.isVisible().catch(() => false)) continue;
        await c.click({ force: true }).catch(() => {});
        clicked = true;
        console.log(`[primeRedeem] fallback click: Button_btn_wrap [${i}]`);
        break;
      }
    }
    if (!clicked) {
      console.log('[primeRedeem] auto-click missed — please click OK in the browser within 60s');
    }

    const resp = await respPromise;
    await this.page.waitForTimeout(300);

    const plaintext = pickRedeemPlaintext(this.captured, String(sampleCoupon));
    if (!plaintext) {
      console.log(`[primeRedeem] used input selector: ${usedInputSelector}`);
      console.log(`[primeRedeem] captured ${this.captured.length} xMidas plaintext(s) during prime:`);
      this.captured.forEach((p, i) => {
        const snippet = p.length > 200 ? p.slice(0, 200) + '…' : p;
        console.log(`  [${i}] len=${p.length}  ${snippet}`);
      });
      await this._dumpRedeemDom('no-plaintext');
      throw new Error('primeRedeem: no QueryRedeemCodeInfo plaintext captured. Diagnostics above.');
    }

    this.redeemTemplate = { plaintext, sampleCoupon: String(sampleCoupon) };

    let data = null;
    if (resp) { try { data = await resp.json(); } catch (_) {} }
    return { status: resp ? resp.status() : null, data, primedWith: String(sampleCoupon) };
  }

  // Diagnostic helper: dump the visible inputs and buttons on the redeem page
  // so we can fix selectors when prime fails.
  async _dumpRedeemDom(tag) {
    try {
      const dom = await this.page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return el.offsetParent !== null && r.width > 0 && r.height > 0;
        };
        const inputs = Array.from(document.querySelectorAll('input'))
          .filter(visible)
          .map((i) => ({
            type: i.type,
            placeholder: i.placeholder,
            maxLength: i.maxLength,
            value: i.value,
            className: i.className.slice(0, 100),
          }));
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], [class*="btn"], [class*="Button"]'))
          .filter(visible)
          .map((b) => ({
            tag: b.tagName,
            text: (b.textContent || '').trim().slice(0, 60),
            className: b.className.slice(0, 100),
          }))
          .filter((b) => b.text.length > 0 && b.text.length < 40);
        return { inputs, buttons };
      });
      console.log(`[primeRedeem:${tag}] visible inputs:`);
      dom.inputs.forEach((i) => console.log(`  ${JSON.stringify(i)}`));
      console.log(`[primeRedeem:${tag}] visible buttons:`);
      dom.buttons.forEach((b) => console.log(`  ${JSON.stringify(b)}`));
    } catch (e) {
      console.log(`[primeRedeem:${tag}] dom-dump failed: ${e.message}`);
    }
  }

  /**
   * Swap redeem_code into the primed plaintext, refresh _id, encrypt, raw POST.
   * Must be called after primeRedeem().
   */
  async validateCoupon(code) {
    if (!this.redeemTemplate) throw new Error('validateCoupon: call primeRedeem() first');
    const obj = JSON.parse(this.redeemTemplate.plaintext);
    obj.redeem_code = String(code);
    if ('_id' in obj) obj._id = String(Math.random());

    // Diagnostic: log country/region fields in the plaintext payload
    const geoKeys = Object.keys(obj).filter((k) => /country|region|area|zone|locale/i.test(k));
    if (geoKeys.length) {
      console.log(`[geo-diag:validateCoupon] plaintext geo fields: ${geoKeys.map((k) => `${k}=${JSON.stringify(obj[k])}`).join(', ')}`);
    }

    const res = await this.rawPost(JSON.stringify(obj), { endpoint: REDEEM_ENDPOINT, referer: buildRedeemUrl(this.country) });

    // Diagnostic: log playerCountryCode and any other geo fields in the response
    if (res.data && typeof res.data === 'object') {
      const respGeo = Object.keys(res.data).filter((k) => /country|region|area|zone|locale/i.test(k));
      if (respGeo.length) {
        console.log(`[geo-diag:validateCoupon] response geo fields: ${respGeo.map((k) => `${k}=${JSON.stringify(res.data[k])}`).join(', ')}`);
      }
    }

    return res;
  }

  /**
   * Drive the redeem-page UI through OK + ارسال with a route intercept that
   * catches the consume POST before it leaves the browser. Coupon is NOT
   * consumed because the network packet never reaches Tencent — we fulfill
   * the fetch with a fake response and capture the would-be URL + body.
   */
  async primeArsal(sampleCoupon) {
    await this._installCaptureBridge();

    if (!this.page.url().includes('/redeem/pubgm')) {
      await this.page.goto(buildRedeemUrl(this.country), { waitUntil: 'domcontentloaded' });
      await this.page.waitForFunction(() =>
        typeof window.xMidas === 'function' &&
        !!document.getElementById('xMidasToken')?.value,
      { timeout: 30000 });
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

    let captured = null;
    let interceptArmed = false;
    const handler = async (route, request) => {
      const url = request.url();
      // Only intercept the specific consume URL — never anything else.
      if (interceptArmed && request.method() === 'POST' && url.includes('os_midaspay_v2') && !captured) {
        let body = null;
        try { body = request.postData(); } catch (_) {}
        if (body) {
          captured = { url, body };
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<html><body>simulated</body></html>',
          });
        }
      }
      return route.continue();
    };
    await this.page.route('**/*', handler);

    try {
      await this.dismissOverlays();

      const couponInput = await this._waitForVisibleInput('input[placeholder*="رمز"]', 10000);
      await couponInput.click({ force: true });
      await couponInput.fill('');
      await couponInput.type(String(sampleCoupon), { delay: 0 });

      // Reset capture buffer so OK's xMidas plaintext is clean to pick up.
      this.captured.length = 0;
      const validationRespPromise = this.page
        .waitForResponse((r) => r.url().includes('QueryRedeemCodeInfo'), { timeout: 30000 })
        .catch(() => null);

      // Click OK — validation goes through normally (intercept is disarmed).
      const okBtn = this.page.locator('[class*="RedeemStepBox_btn_wrap"]')
        .filter({ hasText: /^OK$/i }).first();
      if (await okBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await okBtn.click({ force: true });
      } else {
        // Fall back to any visible Button_btn_wrap with OK text
        const fb = this.page.locator('[class*="Button_btn_wrap"]').filter({ hasText: /^OK$/i }).first();
        await fb.click({ force: true });
      }

      // The OK click also primes the redeem template, since this xMidas call
      // is the QueryRedeemCodeInfo plaintext we'd otherwise capture in a
      // separate primeRedeem. Saves a round of UI driving and avoids the
      // page-state confusion of running two independent primes.
      await validationRespPromise;
      await this.page.waitForTimeout(300);
      const validationPlaintext = pickRedeemPlaintext(this.captured, String(sampleCoupon));
      if (validationPlaintext) {
        this.redeemTemplate = { plaintext: validationPlaintext, sampleCoupon: String(sampleCoupon) };
      }

      // Wait for the ارسال (submit) button in the confirmation dialog.
      // Use the exact XPath from the live DOM to avoid hitting a honeypot
      // or duplicate element matched by loose CSS selectors.
      const arsalXPath = '//*[@id="root"]/div/div[8]/div[7]/div[2]/div/div[6]/div[1]/div/div/div';
      let arsalBtn = null;
      const deadline = Date.now() + 15000;
      while (!arsalBtn && Date.now() < deadline) {
        const candidate = this.page.locator(`xpath=${arsalXPath}`);
        if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
          arsalBtn = candidate;
          break;
        }
        // Fallback: class-based selectors in case DOM structure shifts
        const fallbacks = [
          '[class*="comfirm-btn"]:has-text("إرسال")',
          '[class*="comfirm-btn"]:has-text("ارسال")',
          '[class*="confirm-btn"]:has-text("إرسال")',
        ];
        for (const sel of fallbacks) {
          const b = this.page.locator(sel).first();
          if (await b.isVisible({ timeout: 300 }).catch(() => false)) {
            arsalBtn = b;
            break;
          }
        }
        if (!arsalBtn) await this.page.waitForTimeout(500);
      }
      if (!arsalBtn) {
        // Diagnostic dump — attached to the thrown error so the HTTP
        // handler can return it to the client (in addition to logging).
        let validationData = null;
        try {
          const resp = await validationRespPromise;
          if (resp) validationData = await resp.json().catch(() => null);
        } catch (_) {}
        const dom = await this.page.evaluate(() => {
          const visible = (el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0;
          const buttons = Array.from(document.querySelectorAll('div, button, span, a'))
            .filter(visible)
            .map((el) => ({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60), cls: (el.className || '').toString().slice(0, 100) }))
            .filter((b) => b.text.length > 0 && b.text.length < 50);
          const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600);
          const url = location.href;
          return { url, buttons, bodyText };
        }).catch(() => ({ buttons: [], bodyText: '<dom-eval-failed>', url: this.page.url() }));
        console.log('[primeArsal:no-arsal] url: ' + dom.url);
        console.log('[primeArsal:no-arsal] body snippet: ' + dom.bodyText);
        console.log('[primeArsal:no-arsal] visible buttons (filtered to short text):');
        dom.buttons.slice(0, 30).forEach((b) => console.log('  ' + JSON.stringify(b)));
        if (validationData) {
          console.log('[primeArsal:no-arsal] validation response from form OK click:');
          console.log('  ' + JSON.stringify(validationData).slice(0, 600));
        }
        const err = new Error('primeArsal: ارسال button never appeared');
        err.diagnostic = {
          url: dom.url,
          country: this.country,
          bodyText: dom.bodyText,
          buttons: dom.buttons.slice(0, 30),
          formValidation: validationData,
        };
        throw err;
      }

      // Arm intercept right before the click.
      // Use a human-like click: scroll into view, hover, short delay, then
      // a natural click (no force) so Playwright performs real actionability
      // checks and doesn't bypass overlays or hit a hidden element.
      interceptArmed = true;
      await arsalBtn.scrollIntoViewIfNeeded().catch(() => {});
      await arsalBtn.hover();
      await this.page.waitForTimeout(150 + Math.random() * 200);
      await arsalBtn.click();

      const captureDeadline = Date.now() + 12000;
      while (!captured && Date.now() < captureDeadline) {
        await this.page.waitForTimeout(200);
      }
      if (!captured) {
        throw new Error('primeArsal: ارسال click did not produce a consume POST to intercept');
      }

      this.arsalTemplate = captured;
      return {
        primedWith: String(sampleCoupon),
        url: captured.url,
        bodyLength: captured.body.length,
        redeemPrimed: this.redeemTemplate !== null,
      };
    } finally {
      await this.page.unroute('**/*', handler).catch(() => {});
    }
  }

  /**
   * Build the form body for a real ارسال consume of `code`.
   *
   * Validation runs first to pull `shelf_product_id` (and `is_vip_product`)
   * from the response — those vary by coupon denomination, so we can't reuse
   * the captured template's value blindly. All session-bound tokens
   * (cencrypt_msg, ctoken, pagetoken, __id__) are regenerated from the live
   * page session.
   *
   * dryRun: returns the constructed body WITHOUT POSTing — for inspection.
   */
  async consumeCoupon(code, { dryRun = false, openid = null, playerId = null } = {}) {
    if (!this.arsalTemplate) throw new Error('consumeCoupon: call primeArsal() first');

    const validation = await this.validateCoupon(code);
    if (validation.status !== 200 || validation.data?.ret !== 0) {
      return { stage: 'validation', validation };
    }
    // Validation response shape:
    // { ret: 0, redeem_code_info: { products: [{ product_id, product_properties: [{name,value}, ...] }] } }
    // The form body field name is "shelf_product_id" but the VALUE is the validation's product_id.
    const product = validation.data?.redeem_code_info?.products?.[0] || null;
    const shelfProductId = product?.product_id || null;
    const isVipProperty = product?.product_properties?.find((p) => p.name === 'is_vip_product');
    const isVipProduct = isVipProperty ? isVipProperty.value === 'true' : null;

    const params = new URLSearchParams(this.arsalTemplate.body);

    // Diagnostic: log country/region fields in the arsal form body
    const geoParams = [];
    for (const [k, v] of params) {
      if (/country|region|area|zone|locale/i.test(k)) geoParams.push(`${k}=${v}`);
    }
    if (geoParams.length) {
      console.log(`[geo-diag:consumeCoupon] arsal body geo fields: ${geoParams.join(', ')}`);
    }

    // Override the linked-player fields if the caller specified a target.
    // openid is the player's hy_gameid (resolved via switch/lookup);
    // playerId is the in-game ID. Both fields appear in the consume body.
    if (openid) params.set('openid', String(openid));
    if (playerId) params.set('charac_no', String(playerId));

    const finalOpenid = params.get('openid');
    if (!finalOpenid) throw new Error('consumeCoupon: openid missing from arsal template');

    params.set('redeem_code', String(code));
    if (shelfProductId) params.set('shelf_product_id', shelfProductId);
    if (isVipProduct !== null) params.set('is_vip_product', String(isVipProduct));

    const ts = Date.now();
    params.set('__id__', String(ts));

    const pagetokenPlain = `www.midasbuy.com_${ts}_${finalOpenid}`;
    const pagetoken = Buffer.from(pagetokenPlain, 'utf8').toString('base64');
    params.set('pagetoken', pagetoken);

    const cencryptPlaintext = JSON.stringify({ t: String(ts), h: 'www.midasbuy.com', o: finalOpenid });
    const enc = await this.encrypt(cencryptPlaintext);
    if (!enc) throw new Error('consumeCoupon: encrypt() returned null');
    params.set('cencrypt_msg', enc.encrypt_msg);
    params.set('ctoken', enc.ctoken);
    params.set('ctoken_ver', enc.ctoken_ver);

    // cgi_extend embeds pagetoken; refresh it.
    const oldCgi = params.get('cgi_extend') || '';
    const deviceIdMatch = oldCgi.match(/device_id=([^&]+)/);
    if (deviceIdMatch) {
      params.set('cgi_extend', `pagetoken=${encodeURIComponent(pagetoken)}&device_id=${deviceIdMatch[1]}`);
    }

    const formBody = params.toString();

    if (dryRun) {
      return {
        dryRun: true,
        url: this.arsalTemplate.url,
        method: 'POST',
        bodyLength: formBody.length,
        body: formBody,
        validationResponse: validation.data,
        keyFields: {
          redeem_code: code,
          shelf_product_id: shelfProductId,
          is_vip_product: isVipProduct,
          openid: finalOpenid,
          charac_no: params.get('charac_no'),
          pagetoken,
          cencrypt_msg: enc.encrypt_msg.slice(0, 60) + '…',
          ctoken: enc.ctoken.slice(0, 16) + '…',
          __id__: ts,
        },
      };
    }

    const cookie = await this.cookieHeader();
    const ua = await this.page.evaluate(() => navigator.userAgent);
    const res = await fetch(this.arsalTemplate.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
        'User-Agent': ua,
        Origin: API_BASE,
        Referer: buildRedeemUrl(this.country),
      },
      body: formBody,
      redirect: 'manual',
      ...(this._dispatcher ? { dispatcher: this._dispatcher } : {}),
    });
    const text = await res.text().catch(() => '');
    return {
      status: res.status,
      statusText: res.statusText,
      bodyLength: text.length,
      bodyPreview: text.slice(0, 1500),
      location: res.headers.get('location'),
    };
  }

  /**
   * Drive the redeem-page switch UI once with samplePlayerId so the bundle
   * assembles a /interface/getCharac plaintext with buyType="redeem". The
   * resulting template lets us switch the linked PUBGM player via raw HTTP
   * for any subsequent player_id.
   */
  async primeSwitch(samplePlayerId) {
    await this._installCaptureBridge();

    if (!this.page.url().includes('/redeem/pubgm')) {
      await this.page.goto(buildRedeemUrl(this.country), { waitUntil: 'domcontentloaded' });
      await this.page.waitForFunction(() =>
        typeof window.xMidas === 'function' &&
        !!document.getElementById('xMidasToken')?.value,
      { timeout: 30000 });
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

    await this.dismissOverlays();

    // Click the switch icon on the user-tab card (returning visit shows the
    // currently-linked player; the small switch icon opens the swap dialog).
    const switchBtn = this.page.locator('[class*="UserTabBox_switch_btn"]').first();
    if (!(await switchBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      // Fresh-state fallback: click the user tab itself to open the form
      const tab = this.page.locator('[class*="UserTabBox_use_tab_box"]').first();
      if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click({ force: true });
      } else {
        await this._dumpRedeemDom('no-switch-btn');
        throw new Error('primeSwitch: switch icon / user tab not visible. DOM dump above.');
      }
    } else {
      await switchBtn.click({ force: true });
    }
    await this.page.waitForTimeout(800);

    const input = await this._waitForVisibleInput('input[placeholder*="معرف لاعب"]', 10000);
    await input.click({ force: true });
    await input.fill('');
    await input.type(String(samplePlayerId), { delay: 0 });

    await this.dismissOverlays();
    this.captured.length = 0;

    const respPromise = this.page
      .waitForResponse((r) => r.url().includes('/interface/getCharac'), { timeout: 60000 })
      .catch(() => null);

    const okBtn = this.page.locator('[class*="Button_btn_wrap"]')
      .filter({ hasText: /^OK$/i }).first();
    let clicked = false;
    if (await okBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const cls = await okBtn.getAttribute('class').catch(() => '');
      if (!cls || !/\bfalse\b/.test(cls)) {
        await okBtn.click({ force: true }).catch(() => {});
        clicked = true;
      }
    }
    if (!clicked) {
      console.log('[primeSwitch] auto-click missed — please click OK in the browser within 60s');
    }

    const resp = await respPromise;
    await this.page.waitForTimeout(300);

    const plaintext = pickGetCharacPlaintext(this.captured, String(samplePlayerId));
    if (!plaintext) {
      console.log(`[primeSwitch] captured ${this.captured.length} xMidas plaintext(s) during prime:`);
      this.captured.forEach((p, i) => {
        const snippet = p.length > 200 ? p.slice(0, 200) + '…' : p;
        console.log(`  [${i}] len=${p.length}  ${snippet}`);
      });
      throw new Error('primeSwitch: no getCharac plaintext captured. Diagnostics above.');
    }

    this.switchTemplate = { plaintext, samplePlayerId: String(samplePlayerId) };

    let data = null;
    if (resp) { try { data = await resp.json(); } catch (_) {} }
    return { status: resp ? resp.status() : null, data, primedWith: String(samplePlayerId) };
  }

  /**
   * Switch the session's linked PUBGM player. Replays the primed redeem-page
   * getCharac with the openid swapped to the target player_id.
   */
  async switchPlayer(playerId) {
    if (!this.switchTemplate) throw new Error('switchPlayer: call primeSwitch() first');
    const obj = JSON.parse(this.switchTemplate.plaintext);
    obj.openid = String(playerId);
    if ('_id' in obj) obj._id = String(Math.random());
    return this.rawPost(JSON.stringify(obj), { endpoint: ENDPOINT, referer: buildRedeemUrl(this.country) });
  }

  /**
   * Consume a coupon through the real browser UI. Unlike the raw-HTTP
   * consumeCoupon(), this lets the payment iframe execute its JavaScript
   * so the coupon is actually consumed by Tencent's backend.
   *
   * Full flow: navigate → type code → OK (validation) → ارسال → wait
   * for the payment iframe to complete → detect success/failure via
   * callback URL navigation.
   */
  async consumeViaUI(code) {
    const ts = Date.now();
    const _t = (label) => console.log(`[consumeViaUI] +${Date.now() - ts}ms ${label}`);

    await this._installCaptureBridge();

    // Ensure we're on the redeem page with xMidas hooked.
    if (!this.page.url().includes('/redeem/pubgm')) {
      await this.page.goto(buildRedeemUrl(this.country), { waitUntil: 'domcontentloaded' });
      await this.page.waitForFunction(() =>
        typeof window.xMidas === 'function' &&
        !!document.getElementById('xMidasToken')?.value,
      { timeout: 30000 });
      // Only dismiss overlays on fresh navigation
      await this._fastDismissOverlays();
      await this.page.evaluate(() => {
        if (window.__xMidasOriginal) return;
        window.__xMidasOriginal = window.xMidas;
        window.xMidas = function (arg) {
          try { if (arg && typeof arg.d === 'string') window.__capturePlaintext(arg.d); } catch (_) {}
          return window.__xMidasOriginal.apply(this, arguments);
        };
      });
      _t('page loaded');
    } else {
      // Already on page — just nuke popups without waiting
      await this._fastDismissOverlays();
    }

    // 1. Type coupon code — use fill() directly, skip the slow _waitForVisibleInput
    const couponInput = this.page.locator('input[placeholder*="رمز"]').first();
    await couponInput.waitFor({ state: 'visible', timeout: 5000 });
    await couponInput.fill(String(code));
    _t('typed');

    this.captured.length = 0;

    // 2. Click OK — try both selectors with short timeouts
    const validationRespPromise = this.page
      .waitForResponse((r) => r.url().includes('QueryRedeemCodeInfo'), { timeout: 30000 })
      .catch(() => null);

    let clicked = false;
    const okBtn = this.page.locator('[class*="RedeemStepBox_btn_wrap"]')
      .filter({ hasText: /^OK$/i }).first();
    if (await okBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await okBtn.click({ force: true }).catch(() => {});
      clicked = true;
    }
    if (!clicked) {
      const anyOk = this.page.locator('[class*="btn_wrap"]:has-text("OK"), [class*="btn_wrap"] :has-text("OK")').first();
      if (await anyOk.isVisible({ timeout: 1000 }).catch(() => false)) {
        await anyOk.click({ force: true }).catch(() => {});
        clicked = true;
      }
    }
    if (!clicked) throw new Error('consumeViaUI: could not click OK button');
    _t('OK clicked');

    const validationResp = await validationRespPromise;
    let validationData = null;
    if (validationResp) {
      try { validationData = await validationResp.json(); } catch (_) {}
    }
    _t('validation: ret=' + (validationData?.ret ?? 'null'));

    if (!validationData || validationData.ret !== 0) {
      return { stage: 'validation', validation: validationData };
    }

    // Side-effect: prime the redeem template
    const validationPlaintext = pickRedeemPlaintext(this.captured, String(code));
    if (validationPlaintext) {
      this.redeemTemplate = { plaintext: validationPlaintext, sampleCoupon: String(code) };
    }

    // 3. Wait for ارسال button — fast polling, minimal selectors
    const arsalXPath = '//*[@id="root"]/div/div[8]/div[7]/div[2]/div/div[6]/div[1]/div/div/div';
    let arsalBtn = null;
    const arsalDeadline = Date.now() + 10000;
    while (!arsalBtn && Date.now() < arsalDeadline) {
      // Try exact XPath first (fastest)
      const candidate = this.page.locator(`xpath=${arsalXPath}`);
      if (await candidate.isVisible({ timeout: 200 }).catch(() => false)) {
        arsalBtn = candidate;
        break;
      }
      // Broad fallback — any clickable with إرسال/ارسال text
      for (const txt of ['إرسال', 'ارسال']) {
        const b = this.page.locator(`[class*="comfirm-btn"]:has-text("${txt}"), [class*="confirm"]:has-text("${txt}")`).first();
        if (await b.isVisible({ timeout: 150 }).catch(() => false)) {
          arsalBtn = b;
          break;
        }
      }
      if (!arsalBtn) await this.page.waitForTimeout(100);
    }
    if (!arsalBtn) {
      await this._dumpRedeemDom('consumeViaUI-no-arsal');
      throw new Error('consumeViaUI: ارسال button never appeared');
    }
    _t('ارسال found');

    // 4. Click ارسال — no delay
    await arsalBtn.scrollIntoViewIfNeeded().catch(() => {});
    await arsalBtn.click();
    _t('ارسال clicked');

    // 5. Wait for result — fast polling (200ms), no screenshots
    const resultDeadline = Date.now() + 30000;
    let result = null;
    while (!result && Date.now() < resultDeadline) {
      for (const frame of this.page.frames()) {
        const fUrl = frame.url();
        if (fUrl.includes('/callback/success')) {
          result = { status: 200, outcome: 'success', callbackUrl: fUrl };
        } else if (fUrl.includes('/callback/fail')) {
          result = { status: 400, outcome: 'failed', callbackUrl: fUrl };
        } else if (fUrl.includes('/callback/pending')) {
          result = { status: 202, outcome: 'pending', callbackUrl: fUrl };
        }
        if (result) break;
      }

      if (!result) {
        const popupGone = await this.page.evaluate(() => {
          const pop = document.querySelector('[class*="PopRedeemCodeIframe"]');
          return !pop || window.getComputedStyle(pop).display === 'none';
        }).catch(() => false);
        if (popupGone) {
          const pageText = await this.page.evaluate(() =>
            (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
          ).catch(() => '');
          if (pageText.includes('نجاح') || pageText.includes('success')) {
            result = { status: 200, outcome: 'success', source: 'page-text' };
          } else {
            result = { status: 200, outcome: 'popup-closed', source: 'page-text', pageText: pageText.slice(0, 200) };
          }
        }
      }

      if (!result) await this.page.waitForTimeout(100);
    }

    if (!result) {
      result = { status: 0, outcome: 'timeout' };
    }

    _t('result: ' + result.outcome);
    result.validationData = validationData;
    return result;
  }

  /**
   * Detect login state. The most reliable signal is the coupon input on the
   * redeem page: present + enabled → logged in; present + disabled → not.
   * (Checking for the login modal alone gives false positives because the
   * redeem page doesn't always auto-pop the modal for anonymous sessions —
   * it just disables the input.)
   */
  async _isLoggedIn() {
    if (!this.page.url().includes('midasbuy.com')) {
      await this.page.goto(buildRedeemUrl(this.country), { waitUntil: 'domcontentloaded' });
    }
    await this.page.waitForTimeout(3000);
    await this._fastDismissOverlays();
    await this.dismissOverlays();

    // Check coupon input enabled (original method)
    const couponInput = this.page.locator('input[placeholder*="رمز"]').first();
    const exists = (await couponInput.count().catch(() => 0)) > 0;
    if (exists && await couponInput.isEnabled({ timeout: 1500 }).catch(() => false)) return true;

    // Fallback: check if the page body contains a player name (logged-in indicator)
    const bodyText = await this.page.evaluate(() =>
      (document.body?.innerText || '').slice(0, 1000)
    ).catch(() => '');
    if (/UserTabBox|رصيد|balance/i.test(bodyText) || /\(\d{5,}\)/.test(bodyText)) {
      console.log('[_isLoggedIn] detected logged-in state via page content');
      return true;
    }

    return false;
  }

  /**
   * Drive the login form programmatically. Used when running on a host that
   * can't do interactive `init-login` (Railway, Fly, etc.). Cookies persist
   * in the profile dir so subsequent restarts skip this.
   *
   * Login form schema (captured 2026-05-08): the email input is type="text"
   * and starts with readonly="readonly" (Tencent disables it until the user
   * focuses, to defeat browser autofill). We strip the attribute, type, then
   * click .comfirm-btn (Tencent's typo of "confirm-btn").
   */
  async _login(email, password) {
    if (!email || !password) {
      throw new Error('login: MIDASBUY_EMAIL and MIDASBUY_PASSWORD must be set');
    }

    await this.page.goto(buildRedeemUrl(this.country), { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);

    // Dismiss cookie consent + other popups before attempting login
    await this._fastDismissOverlays();
    await this.dismissOverlays();

    // Diagnostics — Railway often lands on a redirected URL or a captcha page
    // that has nothing in common with the local browser's redeem page.
    try {
      const currentUrl = this.page.url();
      const pageTitle = await this.page.title().catch(() => '');
      const bodyText = await this.page.evaluate(() =>
        (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
      ).catch(() => '');
      console.log(`[login] url=${currentUrl}`);
      console.log(`[login] title=${pageTitle}`);
      console.log(`[login] body=${bodyText}`);
    } catch (_) {}

    // The redeem page rarely auto-pops the login modal for an anonymous
    // session — it just disables the form. We have to surface the modal by
    // clicking some "needs auth" UI element. Try a series of likely triggers
    // until the modal appears.
    let modal = this.page.locator('.have-form-pop').first();
    let visible = await modal.isVisible({ timeout: 2000 }).catch(() => false);

    // If the page redirected to a dedicated login URL, the form may already
    // be on-screen without a .have-form-pop wrapper. Detect by looking for
    // a password input directly.
    if (!visible) {
      const passwordInPage = await this.page.locator('input[type="password"]')
        .first().isVisible({ timeout: 1500 }).catch(() => false);
      if (passwordInPage) {
        console.log('[login] login form is on the page (not in modal)');
        // Submit the form directly, skipping the modal-surfacing dance.
        const emailIn = this.page.locator('input[type="text"], input[type="email"]').first();
        await emailIn.evaluate((el) => el.removeAttribute('readonly')).catch(() => {});
        await emailIn.click({ force: true });
        await emailIn.fill('');
        await emailIn.type(String(email), { delay: 30 });

        const pwIn = this.page.locator('input[type="password"]').first();
        await pwIn.click({ force: true });
        await pwIn.fill('');
        await pwIn.type(String(password), { delay: 30 });

        const submit = this.page.locator('.comfirm-btn, [class*="confirm-btn"], button[type="submit"]').first();
        await submit.click({ force: true }).catch(() => {});

        // Wait for navigation away from login OR for the password field to disappear
        await Promise.race([
          this.page.waitForFunction(() => !document.querySelector('input[type="password"]'), { timeout: 30000 }),
          this.page.waitForURL(/\/redeem\//, { timeout: 30000 }),
        ]).catch(() => {});

        return; // login attempt done, caller will verify via _isLoggedIn
      }
    }

    if (!visible) {
      const triggers = [
        // Most likely: the user-tab card itself prompts login when nothing's linked
        '[class*="UserTabBox_use_tab_box"]',
        // Or the disabled coupon input may surface the modal on click
        'input[placeholder*="رمز"]',
        // Generic class-name fallbacks
        '[class*="LoginBtn"]',
        '[class*="login_btn"]',
        '[class*="signin"]',
        // Text-based last resort (Sign In + Arabic equivalent)
        'a:has-text("Sign In")',
        'div:has-text("تسجيل الدخول إلى حساب")',
        'div:has-text("تسجيل الدخول")',
        '[class*="btn"]:has-text("تسجيل")',
      ];
      for (const sel of triggers) {
        const t = this.page.locator(sel).first();
        if (!(await t.isVisible({ timeout: 1000 }).catch(() => false))) continue;
        console.log(`[login] surface attempt: ${sel}`);
        await t.click({ force: true }).catch(() => {});
        await this.page.waitForTimeout(1500);
        visible = await modal.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          console.log(`[login] modal surfaced via ${sel}`);
          break;
        }
      }
    }
    if (!visible) {
      await this._dumpRedeemDom('login-no-modal');
      throw new Error('login: could not surface login modal. DOM dump above.');
    }

    const emailInput = this.page.locator('.have-form-pop input[type="text"]').first();
    await emailInput.evaluate((el) => el.removeAttribute('readonly')).catch(() => {});
    await emailInput.click({ force: true });
    await emailInput.fill('');
    await emailInput.type(String(email), { delay: 30 });

    const passwordInput = this.page.locator('.have-form-pop input[type="password"]').first();
    await passwordInput.click({ force: true });
    await passwordInput.fill('');
    await passwordInput.type(String(password), { delay: 30 });

    const submitBtn = this.page.locator('.have-form-pop .comfirm-btn').first();
    await submitBtn.click({ force: true });

    const closed = await modal.waitFor({ state: 'hidden', timeout: 30000 })
      .then(() => true).catch(() => false);

    if (!closed) {
      const errors = await this.page.locator('.have-form-pop .error-tips')
        .allTextContents().catch(() => []);
      const errMsg = errors.map((s) => s.trim()).filter(Boolean).join('; ');
      throw new Error(`login: modal did not close. ${errMsg || 'Possible captcha or bad credentials.'}`);
    }

    // Confirm the redeem form is reachable post-login.
    await this.page.waitForFunction(() =>
      typeof window.xMidas === 'function' &&
      !!document.getElementById('xMidasToken')?.value,
    { timeout: 20000 }).catch(() => {});
  }

  async close() {
    // context.close() also closes the underlying browser process for both
    // persistent and non-persistent contexts.
    await this.context.close();
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

// Identify the QueryRedeemCodeInfo plaintext: it's the only captured one that
// has a redeem_code field equal to what we just typed.
function pickRedeemPlaintext(captured, sampleCoupon) {
  for (const p of captured) {
    let o; try { o = JSON.parse(p); } catch (_) { continue; }
    if (o && typeof o === 'object' && o.redeem_code === sampleCoupon) return p;
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

function waitForEnter(prompt = 'Press Enter when done... ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
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

async function cmdLookup({ ids, visible, proxy, forceCountry }) {
  const proxyConfig = proxy || resolveProxyConfig(forceCountry || DEFAULT_COUNTRY);
  const oracle = await MidasOracle.launch({
    headless: !visible,
    proxy: proxyConfig,
    forceCountry,
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

async function cmdPipe({ playerId, codes, visible, proxy, forceCountry }) {
  const proxyConfig = proxy || resolveProxyConfig(forceCountry || DEFAULT_COUNTRY);
  const oracle = await MidasOracle.launch({ headless: !visible, proxy: proxyConfig, forceCountry });
  try {
    console.log(`[1] Switching to player ${playerId}...`);
    let t = Date.now();
    const sw = await oracle.primeSwitch(playerId);
    const swName = sw.data?.info?.charac_name;
    console.log(`    OK (${Date.now() - t}ms) — ${swName ? `switched to ${swName}` : `HTTP ${sw.status}`}`);
    console.log('');

    // Let the page settle after the switch (success popup, transition state).
    await oracle.page.waitForTimeout(1200);
    await oracle.dismissOverlays();

    console.log(`[2] Validating coupon ${codes[0]} for ${swName || playerId}...`);
    t = Date.now();
    const c0 = await oracle.primeRedeem(codes[0]);
    console.log(`    OK (${Date.now() - t}ms) — HTTP ${c0.status}`);
    console.log(`[+] ${codes[0]}:`);
    console.log(fmt(c0.data));

    for (let i = 1; i < codes.length; i++) {
      const code = codes[i];
      console.log('');
      console.log(`[${i + 2}] Validating ${code} (raw)...`);
      t = Date.now();
      const r = await oracle.validateCoupon(code);
      console.log(`    ${Date.now() - t}ms — HTTP ${r.status}`);
      console.log(`[+] ${code}:`);
      console.log(fmt(r.data));
    }
  } finally {
    await oracle.close();
  }
}

async function cmdSwitch({ ids, visible, proxy, forceCountry }) {
  const proxyConfig = proxy || resolveProxyConfig(forceCountry || DEFAULT_COUNTRY);
  const oracle = await MidasOracle.launch({ headless: !visible, proxy: proxyConfig, forceCountry });
  try {
    console.log(`[1] Priming switch with player ${ids[0]}...`);
    const t1 = Date.now();
    const primed = await oracle.primeSwitch(ids[0]);
    console.log(`    OK (${Date.now() - t1}ms) — HTTP ${primed.status}`);
    console.log('');
    console.log(`[+] Switched to ${ids[0]}:`);
    console.log(fmt(primed.data));

    for (let i = 1; i < ids.length; i++) {
      const id = ids[i];
      console.log('');
      console.log(`[${i + 1}] Switching to ${id} (raw)...`);
      const t = Date.now();
      const res = await oracle.switchPlayer(id);
      console.log(`    ${Date.now() - t}ms — HTTP ${res.status}`);
      console.log(`[+] ${id}:`);
      console.log(fmt(res.data));
    }
  } finally {
    await oracle.close();
  }
}

async function cmdCoupon({ codes, visible, proxy, forceCountry }) {
  const proxyConfig = proxy || resolveProxyConfig(forceCountry || DEFAULT_COUNTRY);
  const oracle = await MidasOracle.launch({ headless: !visible, proxy: proxyConfig, forceCountry });
  try {
    console.log(`[1] Priming redeem template with ${codes[0]}...`);
    const t1 = Date.now();
    const primed = await oracle.primeRedeem(codes[0]);
    console.log(`    OK (${Date.now() - t1}ms) — HTTP ${primed.status}`);
    console.log('');
    console.log(`[+] ${codes[0]}:`);
    console.log(fmt(primed.data));

    for (let i = 1; i < codes.length; i++) {
      const code = codes[i];
      console.log('');
      console.log(`[${i + 1}] Raw POST for ${code}...`);
      const t = Date.now();
      const res = await oracle.validateCoupon(code);
      console.log(`    ${Date.now() - t}ms — HTTP ${res.status}`);
      console.log(`[+] ${code}:`);
      console.log(fmt(res.data));
    }
  } finally {
    await oracle.close();
  }
}

async function cmdArsalTest({ code, visible, real, playerId, proxy, forceCountry }) {
  const proxyConfig = proxy || resolveProxyConfig(forceCountry || DEFAULT_COUNTRY);
  const oracle = await MidasOracle.launch({ headless: !visible, proxy: proxyConfig, forceCountry });
  try {
    let t = Date.now();
    let targetOpenid = null;

    // Order matters here: switch → type coupon → OK → ارسال is one
    // continuous redeem walk. primeArsal does the type+OK+ارسال in one go
    // and captures both the redeem template (from OK) and the arsal
    // template (from ارسال, intercept-protected — no consume).
    if (playerId) {
      console.log(`[1] Switching to player ${playerId}...`);
      const sw = await oracle.primeSwitch(String(playerId));
      if (sw.data?.ret !== 0 || !sw.data?.info?.openid) {
        console.log('    SWITCH FAILED:');
        console.log(JSON.stringify(sw, null, 2));
        return;
      }
      targetOpenid = sw.data.info.openid;
      console.log(`    OK (${Date.now() - t}ms) — switched to ${sw.data.info.charac_name} (openid=${targetOpenid})`);
    }

    console.log(`[2] Type coupon → OK → ارسال (intercepted; coupon NOT consumed)...`);
    t = Date.now();
    const primed = await oracle.primeArsal(code);
    console.log(`    OK (${Date.now() - t}ms) — arsal=${primed.bodyLength}b, redeemPrimed=${primed.redeemPrimed}`);

    const opts = { dryRun: !real, openid: targetOpenid, playerId };

    if (real) {
      console.log('');
      console.log(`[3] !!! REAL CONSUME of ${code}${playerId ? ' for player ' + playerId : ''} !!!`);
      t = Date.now();
      const r = await oracle.consumeCoupon(code, opts);
      console.log(`    HTTP ${r.status} in ${Date.now() - t}ms`);
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log('');
      console.log(`[3] Dry-run consume of ${code}${playerId ? ' (target player ' + playerId + ')' : ''} (NO request to Tencent)...`);
      t = Date.now();
      const r = await oracle.consumeCoupon(code, opts);
      console.log(`    Built body in ${Date.now() - t}ms`);
      console.log('');
      console.log('--- key fields swapped vs template ---');
      console.log(JSON.stringify(r.keyFields, null, 2));
      console.log('');
      console.log('--- validation response (server confirmed coupon is valid) ---');
      console.log(JSON.stringify(r.validationResponse, null, 2));
      console.log('');
      console.log('--- full constructed form body ---');
      console.log(r.body);
      console.log('');
      console.log(`(would POST ${r.bodyLength} bytes to ${r.url})`);
    }
  } finally {
    await oracle.close();
  }
}

async function cmdInitLogin() {
  console.log('Opening browser to ' + REDEEM_URL);
  console.log('Profile will be saved to ' + PROFILE_DIR);
  const oracle = await MidasOracle.launch({ headless: false });
  await oracle.page.goto(REDEEM_URL, { waitUntil: 'domcontentloaded' });

  console.log('');
  console.log('In the browser:');
  console.log('  1. Click the Sign In / login button');
  console.log('  2. Complete the login flow (email, Google, etc.)');
  console.log('  3. Land back on the redeem page in a logged-in state');
  console.log('');

  await waitForEnter('Press Enter here once you\'re logged in to save the session... ');

  console.log('Saving and closing...');
  await oracle.close();
  console.log('Done. Future runs will reuse this profile.');
}

async function cmdCaptureArsal() {
  const fs = require('fs');
  const LOG_FILE = path.join(__dirname, '.midasbuy-arsal-capture.log');

  console.log('Opening browser to ' + REDEEM_URL);
  const oracle = await MidasOracle.launch({ headless: false });
  await oracle._installCaptureBridge();
  await oracle.page.goto(REDEEM_URL, { waitUntil: 'domcontentloaded' });

  await oracle.page.waitForFunction(() =>
    typeof window.xMidas === 'function' &&
    !!document.getElementById('xMidasToken')?.value,
  { timeout: 30000 });

  await oracle.page.evaluate(() => {
    if (window.__xMidasOriginal) return;
    window.__xMidasOriginal = window.xMidas;
    window.xMidas = function (arg) {
      try { if (arg && typeof arg.d === 'string') window.__capturePlaintext(arg.d); } catch (_) {}
      return window.__xMidasOriginal.apply(this, arguments);
    };
  });

  // Set up the intercept. While disarmed, every request flows through normally
  // (so OK validation works and ارسال appears). Once armed, every encrypted
  // POST that's NOT a known telemetry endpoint is captured and fulfilled with
  // a fake success — the request never reaches Tencent, so the coupon is not
  // actually consumed. Telemetry (heartbeat, webdata, pagereport, forter,
  // etc.) is allowed through unchanged so it doesn't pollute the capture.
  let interceptArmed = false;
  const interceptedReqs = [];
  const trace = [];

  const isTelemetryUrl = (u) => (
    /\/report\/midasbuy\/v1\/(heartbeat|webdata)/.test(u) ||
    /pagereport/.test(u) ||
    /report1\.midasbuy\.com/.test(u) ||
    /pay\.harvestsharp\.com/.test(u) ||
    /forter\.com/.test(u) ||
    /galileotelemetry/.test(u) ||
    /pagedooapi\.midasbuy\.com\/api\/pagereport/.test(u) ||
    /google-analytics/.test(u)
  );

  await oracle.page.route('**/*', async (route, request) => {
    const url = request.url();

    // Trace every non-static POST so we can see the full network picture
    // when reviewing what ارسال actually fired.
    if (request.method() === 'POST' &&
        !/\.(js|css|png|jpe?g|svg|gif|woff2?|ico|mp4|webp|json)(\?|$)/i.test(url) &&
        !isTelemetryUrl(url)) {
      try {
        const pd = request.postData();
        trace.push({ url, method: request.method(), body: pd, t: Date.now() });
      } catch (_) {}
    }

    if (interceptArmed && request.method() === 'POST' && !isTelemetryUrl(url)) {
      let body = null;
      try { body = request.postData(); } catch (_) {}
      if (body && body.includes('encrypt_msg')) {
        interceptedReqs.push({ url, method: request.method(), body, t: Date.now() });
        console.log(`[INTERCEPTED] ${url}`);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ret: 0, info: { simulated: true }, msg: 'simulated' }),
        });
      }
    }
    return route.continue();
  });

  console.log('');
  console.log('Browser is on the redeem page. Step-by-step:');
  console.log('  1. (If you switched player recently or anything looks off, close popups.)');
  console.log('  2. Type a REAL VALID coupon code into the input.');
  console.log('  3. Click OK. Wait for the validation success — the ارسال button should appear.');
  console.log('  4. Come back here and press Enter to ARM the intercept.');
  console.log('  5. Then click ارسال. Bundle fires the consume request — we capture it');
  console.log('     and return fake success without sending to Tencent.');
  console.log('  6. Come back here and press Enter again to dump the captured schema.');
  console.log('');

  await waitForEnter('Step 4: Press Enter once OK was clicked and ارسال is showing... ');

  interceptArmed = true;
  console.log('');
  console.log('--- INTERCEPT ARMED ---');
  console.log('Click ارسال in the browser now. The request will be captured but NOT sent.');
  console.log('');

  await waitForEnter('Step 6: Press Enter once you clicked ارسال... ');
  interceptArmed = false;

  console.log('');
  console.log('====== xMidas plaintexts captured during the session ======');
  oracle.captured.forEach((p, i) => {
    const head = p.length > 250 ? p.slice(0, 250) + '…' : p;
    console.log(`[${i}] len=${p.length}  head=${head}`);
  });

  if (interceptedReqs.length) {
    console.log('');
    console.log('====== Intercepted requests (after arming) ======');
    interceptedReqs.forEach((r, i) => {
      console.log(`--- [${i}] ${r.url}`);
      const head = r.body && r.body.length > 400 ? r.body.slice(0, 400) + `…(${r.body.length})` : r.body;
      console.log('    body: ' + head);
    });
  } else {
    console.log('');
    console.log('No encrypted POSTs were intercepted after arming. Possible reasons:');
    console.log('  - You did not click ارسال after arming.');
    console.log('  - ارسال only triggered a non-encrypted call.');
    console.log('  - ارسال triggered nothing (validation might have actually failed silently).');
  }

  console.log('');
  console.log('====== Full network trace (POSTs, non-static, non-telemetry) ======');
  trace.forEach((r, i) => {
    const head = r.body && r.body.length > 250 ? r.body.slice(0, 250) + `…(${r.body.length})` : (r.body || '<no body>');
    console.log(`[${i}] ${r.method} ${r.url}`);
    console.log('    body: ' + head);
  });

  // Dump everything to a file too in case the terminal truncates
  fs.writeFileSync(LOG_FILE, JSON.stringify({
    interceptedReqs,
    captured: oracle.captured,
    trace,
  }, null, 2));
  console.log('');
  console.log('Full dump written to ' + LOG_FILE);

  await oracle.close();
}

async function cmdCaptureRedeem() {
  const fs = require('fs');
  const LOG_FILE = path.join(__dirname, '.midasbuy-redeem-capture.log');

  console.log('Opening browser to ' + REDEEM_URL);
  const oracle = await MidasOracle.launch({ headless: false });
  await oracle._installCaptureBridge();
  await oracle.page.goto(REDEEM_URL, { waitUntil: 'domcontentloaded' });

  await oracle.page.waitForFunction(() =>
    typeof window.xMidas === 'function' &&
    !!document.getElementById('xMidasToken')?.value,
  { timeout: 30000 });

  await oracle.page.evaluate(() => {
    if (window.__xMidasOriginal) return;
    window.__xMidasOriginal = window.xMidas;
    window.xMidas = function (arg) {
      try { if (arg && typeof arg.d === 'string') window.__capturePlaintext(arg.d); } catch (_) {}
      return window.__xMidasOriginal.apply(this, arguments);
    };
  });

  const trace = [];
  oracle.page.on('request', (req) => {
    const u = req.url();
    if (/\.(js|css|png|jpg|jpeg|svg|gif|woff2?|ico|mp4|webp|json)(\?|$)/i.test(u)) return;
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    let body = null;
    try {
      const pd = req.postData();
      if (pd) body = pd;
    } catch (_) {}
    trace.push({ url: u, method: req.method(), body, t: Date.now() });
  });

  oracle.captured.length = 0;

  console.log('');
  console.log('Browser is on the redeem page. In the UI:');
  console.log('  1. Verify you\'re logged in.');
  console.log('  2. (Optional) Switch the linked player ID via the switch-icon.');
  console.log('  3. Type a coupon code into the input.');
  console.log('  4. Click OK to confirm, then ارسال to submit.');
  console.log('  5. Wait for the success/error response from the server.');
  console.log('  6. Come back here and press Enter.');
  console.log('');

  await waitForEnter('Press Enter when the redemption response is back... ');

  // Filters: drop the high-volume telemetry that drowns the signal.
  const TELEMETRY_HOSTS = [
    'report1.midasbuy.com',
    'galileotelemetry',
    'google-analytics',
    'cdn3.forter.com',
    'pay.harvestsharp.com',
  ];
  const TELEMETRY_PATHS = [
    '/api/pagereport',
    '/report/midasbuy/v1/heartbeat',
    '/report/midasbuy/v1/webdata',
    '/api/activity-initialize/many-valid-events',
  ];
  const isTelemetryUrl = (u) =>
    TELEMETRY_HOSTS.some((h) => u.includes(h)) ||
    TELEMETRY_PATHS.some((p) => u.includes(p));
  const isReportPlaintext = (s) => {
    try {
      const o = JSON.parse(s);
      return !!(o && (o.basicData || o.events || o.reportType || o.t !== undefined));
    } catch (_) { return false; }
  };

  const interestingTrace = trace.filter((r) => !isTelemetryUrl(r.url));
  const interestingPlaintexts = oracle.captured
    .map((p, i) => ({ i, p }))
    .filter(({ p }) => !isReportPlaintext(p));

  // Build full log (everything) and focused log (signal only) and write both.
  const fullLines = [];
  fullLines.push('===== FULL network trace =====');
  for (const r of trace) {
    fullLines.push(`${r.method} ${r.url}`);
    if (r.body) fullLines.push('    body: ' + r.body);
  }
  fullLines.push('');
  fullLines.push('===== FULL xMidas plaintexts =====');
  oracle.captured.forEach((p, i) => {
    fullLines.push(`[${i}] len=${p.length}`);
    fullLines.push('    ' + p);
  });
  fs.writeFileSync(LOG_FILE, fullLines.join('\n'));

  console.log('');
  console.log('====== Filtered network trace (no telemetry) ======');
  for (const r of interestingTrace) {
    console.log(`${r.method} ${r.url}`);
    if (r.body) {
      const b = r.body.length > 800 ? r.body.slice(0, 800) + `…(${r.body.length})` : r.body;
      console.log('    body: ' + b);
    }
  }
  console.log('');
  console.log('====== Filtered xMidas plaintexts (no telemetry) ======');
  for (const { i, p } of interestingPlaintexts) {
    console.log(`[${i}] len=${p.length}`);
    console.log('    ' + p);
  }
  console.log('');
  console.log(`Trace: ${interestingTrace.length} interesting / ${trace.length} total`);
  console.log(`xMidas: ${interestingPlaintexts.length} interesting / ${oracle.captured.length} total`);
  console.log(`Full unfiltered dump written to ${LOG_FILE}`);

  await oracle.close();
}

async function cmdServe({ port, visible, primeWith, forceCountry, proxy }) {
  // When PORT is set by the host (Railway, Fly, Heroku, etc.) we bind to
  // all interfaces; otherwise stay on loopback so a local dev daemon isn't
  // exposed on the LAN by accident.
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  const bindHost = envPort ? '0.0.0.0' : '127.0.0.1';
  const bindPort = envPort || port;

  // Resolve proxy from args or env vars.
  const proxyConfig = proxy || resolveProxyConfig(forceCountry || DEFAULT_COUNTRY);

  // Bearer-token auth, opt-in via env var. Set AUTH_TOKEN on the host to
  // require Authorization: Bearer <token> on every request.
  const authToken = process.env.AUTH_TOKEN || null;
  const oracle = await MidasOracle.launch({
    headless: !visible,
    proxy: proxyConfig,
    forceCountry,
    onLog: (event) => {
      if (event === 'reprime') console.log('[oracle] re-priming (token rotation / auth error)');
      else if (typeof event === 'string' && event.startsWith('reprime-failed:')) console.log('[oracle] ' + event);
    },
  });

  if (forceCountry) console.log(`[0] force-country=${forceCountry} — auto-country switching disabled`);
  if (proxyConfig) console.log(`[0] proxy=${proxyConfig.server}${proxyConfig.username ? ' (auth)' : ''}`);

  console.log('[1] Warming oracle...');
  const t0 = Date.now();
  await oracle.warmup();
  console.log(`    OK (${Date.now() - t0}ms)`);

  // Auto-login when running on a host that can't do interactive init-login
  // (Railway, Fly, etc.). Set MIDASBUY_EMAIL + MIDASBUY_PASSWORD env vars and
  // mount a persistent volume at .midasbuy-profile so cookies survive restarts.
  const email = process.env.MIDASBUY_EMAIL;
  const password = process.env.MIDASBUY_PASSWORD;
  if (email && password) {
    const tLogin = Date.now();
    const already = await oracle._isLoggedIn();
    if (already) {
      console.log(`[1.5] Already logged in via persistent profile (${Date.now() - tLogin}ms)`);
    } else {
      console.log(`[1.5] Not logged in — running programmatic login as ${email}...`);
      try {
        await oracle._login(email, password);
        console.log(`    OK (${Date.now() - tLogin}ms)`);
      } catch (err) {
        console.error(`    LOGIN FAILED: ${err.message || err}`);
        console.error('    The daemon will keep running, but redeem-flow endpoints will fail.');
      }
    }
  }

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
      return send(200, {
        ok: true,
        country: oracle.country,
        forceCountry: oracle.forceCountry || null,
        proxy: oracle._proxyConfig ? { server: oracle._proxyConfig.server, hasAuth: !!oracle._proxyConfig.username } : null,
        primed: {
          lookup: oracle.sessionTemplate !== null,
          switch: oracle.switchTemplate !== null,
          coupon: oracle.redeemTemplate !== null,
          arsal: oracle.arsalTemplate !== null,
        },
      });
    }

    if (authToken) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (got !== authToken) return send(401, { error: 'unauthorized' });
    }

    // Optional ?country=<iso2> retargets the daemon to a different Midasbuy
    // region. setCountry() wipes redeem-flow templates so they re-prime
    // against the new region; same-country calls are a no-op.
    const countryParam = url.searchParams.get('country');

    const lookupMatch = url.pathname.match(/^\/lookup\/(\d+)$/);
    const switchMatch = url.pathname.match(/^\/switch\/(\d+)$/);
    const couponMatch = url.pathname.match(/^\/coupon\/([A-Za-z0-9]{4,})$/);
    const arsalMatch = url.pathname.match(/^\/arsal\/([A-Za-z0-9]{4,})$/);

    if (!lookupMatch && !switchMatch && !couponMatch && !arsalMatch) {
      return send(404, { error: 'not found' });
    }

    const route = lookupMatch ? 'lookup' : switchMatch ? 'switch' : couponMatch ? 'coupon' : 'arsal';
    const arg = (lookupMatch || switchMatch || couponMatch || arsalMatch)[1];

    queue(async () => {
      const t = Date.now();
      let r;
      // Apply region override (no-op when same as current; wipes templates
      // when different so they re-prime against the new region's pages).
      if (countryParam) await oracle.setCountry(countryParam);
      // When ?country= is explicitly provided (or --force-country is set),
      // skip auto-country switching — the caller knows which region to use.
      const skipAutoCountry = !!countryParam || !!oracle.forceCountry
        || url.searchParams.get('autocountry') === '0';
      if (route === 'lookup') {
        r = oracle.sessionTemplate
          ? await oracle.lookup(arg)
          : await oracle.prime(arg);
      } else if (route === 'switch') {
        r = oracle.switchTemplate
          ? await oracle.switchPlayer(arg)
          : await oracle.primeSwitch(arg);
      } else if (route === 'coupon') {
        r = oracle.redeemTemplate
          ? await oracle.validateCoupon(arg)
          : await oracle.primeRedeem(arg);
        // Auto-detect country from validation response — unless the caller
        // explicitly set ?country= or the daemon has --force-country.
        if (!skipAutoCountry) {
          await oracle._maybeAutoSwitchCountry(r.data);
        }
      } else {
        // arsal — destructive. Drives the full redeem UI flow through
        // the real browser so the payment iframe executes and the coupon
        // is actually consumed. Optional ?player=<id> switches first.
        const playerId = url.searchParams.get('player');

        if (playerId) {
          const sw = oracle.switchTemplate
            ? await oracle.switchPlayer(playerId)
            : await oracle.primeSwitch(playerId);
          if (sw.data?.ret !== 0 || !sw.data?.info?.openid) {
            return { httpStatus: 400, body: { stage: 'switch', error: 'switch failed', detail: sw.data }, ms: Date.now() - t };
          }
        }

        r = await oracle.consumeViaUI(arg);
        r.ms = Date.now() - t;
        return { httpStatus: r.status || 200, body: r, ms: r.ms };
      }
      return { httpStatus: r.status || 200, body: r.data, ms: Date.now() - t };
    }).then(
      (r) => {
        const summary = r.body?.info?.charac_name || r.body?.msg || '';
        console.log(`[${route}] ${arg} → HTTP ${r.httpStatus} (${r.ms}ms) ${summary}`);
        send(r.httpStatus, r.body);
      },
      (err) => {
        console.error(`[${route}] ${arg} → error: ${err.message || err}`);
        const body = { error: String(err.message || err) };
        // Errors thrown with a .diagnostic payload (e.g., primeArsal when
        // ارسال never appears) carry useful debug info — include it so
        // remote callers don't have to read journalctl on the daemon host.
        if (err && err.diagnostic) body.diagnostic = err.diagnostic;
        send(500, body);
      },
    );
  });

  server.listen(bindPort, bindHost, () => {
    console.log('');
    console.log(`[3] Listening on http://${bindHost}:${bindPort}`);
    console.log(`    curl http://${bindHost}:${bindPort}/lookup/<player_id>`);
    console.log(`    curl http://${bindHost}:${bindPort}/switch/<player_id>`);
    console.log(`    curl http://${bindHost}:${bindPort}/coupon/<code>`);
    console.log(`    curl http://${bindHost}:${bindPort}/arsal/<code>?player=<id>   (destructive — burns the coupon)`);
    console.log(`    add &country=<iso2>  to any of the above to switch region (default ${DEFAULT_COUNTRY})`);
    console.log(`    curl http://${bindHost}:${bindPort}/health`);
    if (authToken) console.log('    auth: Authorization: Bearer <AUTH_TOKEN>  (required)');
    else console.log('    auth: none (set AUTH_TOKEN env var to require a bearer token)');
    console.log('');
    console.log('    Ctrl+C to shut down.');
  });

  // --- Self-heal watchdog ---
  // Every SELF_HEAL_INTERVAL_MS, run a known-good lookup against Tencent.
  // The existing reactive re-prime inside lookup() heals any token rot the
  // moment we discover it, so this just drives that discovery proactively
  // (without waiting for a real user request to find the failure first).
  // Set SELF_HEAL_INTERVAL_MS=0 to disable.
  const intervalMs = process.env.SELF_HEAL_INTERVAL_MS !== undefined
    ? parseInt(process.env.SELF_HEAL_INTERVAL_MS, 10)
    : 10 * 60 * 1000;
  let healTimer = null;
  if (intervalMs > 0) {
    healTimer = setInterval(() => {
      // Only meaningful once at least one template is primed. If lazy-priming
      // hasn't happened yet, there's nothing to keep warm.
      if (!oracle.lastSamplePlayerId) return;
      if (!oracle.sessionTemplate && !oracle.switchTemplate) return;

      queue(async () => {
        const id = oracle.lastSamplePlayerId;
        const op = oracle.sessionTemplate ? 'lookup' : 'switch';
        try {
          const t0 = Date.now();
          const r = await (op === 'lookup'
            ? oracle.lookup(id)
            : oracle.switchPlayer(id));
          const ms = Date.now() - t0;
          if (r.data?.ret === 0) {
            // Healthy. Stay quiet to avoid log spam.
          } else {
            console.log(`[selfheal] ${op}(${id}) → ret=${r.data?.ret} (${ms}ms) — reactive reprime should have already fired`);
          }
        } catch (err) {
          console.log(`[selfheal] ${op}(${id}) threw: ${err.message || err}`);
        }
      });
    }, intervalMs);
    console.log(`    selfheal: every ${Math.round(intervalMs / 60000)} min (set SELF_HEAL_INTERVAL_MS=0 to disable)`);
  }

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[+] ${sig} — closing browser...`);
    if (healTimer) clearInterval(healTimer);
    server.close();
    try { await oracle.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printUsage() {
  console.log('Usage:');
  console.log('  node midasbuy-hybrid.js lookup         <id1> [id2] ...    [--visible]');
  console.log('  node midasbuy-hybrid.js switch         <id1> [id2] ...    [--visible]   (switch the linked PUBGM player on the redeem flow)');
  console.log('  node midasbuy-hybrid.js coupon         <code1> [code2] ... [--visible]');
  console.log('  node midasbuy-hybrid.js pipe           <player_id> <code1> [code2] ... [--visible]   (switch + validate in one session)');
  console.log('  node midasbuy-hybrid.js serve          [--port=7777] [--prime=<id>] [--visible]');
  console.log('  node midasbuy-hybrid.js init-login     (one-time, opens browser to log in)');
  console.log('  node midasbuy-hybrid.js capture-redeem (capture an unknown flow on the redeem page)');
  console.log('  node midasbuy-hybrid.js capture-arsal  (intercept the ارسال submit so we learn its schema without burning a coupon)');
  console.log('  node midasbuy-hybrid.js arsal-test     <validCode> [--player=<id>] [--real] [--visible]   (primes via UI then dry-runs the consume; --real does the actual consume — burns the coupon; --player retargets the redeem to a specific player)');
  console.log('');
  console.log('Global options:');
  console.log('  --force-country=<iso2>   Lock to a country, disable auto-country switching');
  console.log('  --proxy=<url>            Route browser+HTTP through a proxy (e.g. http://host:port)');
  console.log('');
  console.log('Proxy env vars:  PROXY_URL, PROXY_USER, PROXY_PASS  (global)');
  console.log('                 PROXY_EG, PROXY_EG_USER, PROXY_EG_PASS  (per-country override)');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const visible = args.includes('--visible');

  // Global: --force-country=<iso2> and --proxy=<url>
  const fcArg = args.find((a) => /^--force-country=\w+$/.test(a));
  const forceCountry = fcArg ? fcArg.split('=')[1].toLowerCase() : (process.env.FORCE_COUNTRY || null);
  const proxyArg = args.find((a) => /^--proxy=/.test(a));
  const proxy = proxyArg
    ? { server: proxyArg.split('=').slice(1).join('='), username: '', password: '' }
    : null;

  if (cmd === 'serve') {
    const portArg = args.find((a) => /^--port=\d+$/.test(a));
    const port = portArg ? parseInt(portArg.split('=')[1], 10) : 7777;
    const primeArg = args.find((a) => /^--prime=\d+$/.test(a));
    const primeWith = primeArg ? primeArg.split('=')[1] : (process.env.PRIME_ID || null);
    return cmdServe({ port, visible, primeWith, forceCountry, proxy });
  }

  if (cmd === 'lookup') {
    const ids = args.slice(1).filter((a) => /^\d+$/.test(a));
    if (ids.length === 0) { printUsage(); process.exit(1); }
    return cmdLookup({ ids, visible, proxy, forceCountry });
  }

  if (cmd === 'coupon') {
    const codes = args.slice(1).filter((a) => /^[A-Za-z0-9]{4,}$/.test(a));
    if (codes.length === 0) { printUsage(); process.exit(1); }
    return cmdCoupon({ codes, visible, proxy, forceCountry });
  }

  if (cmd === 'switch') {
    const ids = args.slice(1).filter((a) => /^\d+$/.test(a));
    if (ids.length === 0) { printUsage(); process.exit(1); }
    return cmdSwitch({ ids, visible, proxy, forceCountry });
  }

  if (cmd === 'pipe') {
    const tokens = args.slice(1).filter((a) => !a.startsWith('--'));
    const playerId = tokens[0];
    const codes = tokens.slice(1).filter((a) => /^[A-Za-z0-9]{4,}$/.test(a));
    if (!playerId || !/^\d+$/.test(playerId) || codes.length === 0) {
      console.log('Usage: node midasbuy-hybrid.js pipe <player_id> <code1> [code2] ... [--visible]');
      process.exit(1);
    }
    return cmdPipe({ playerId, codes, visible, proxy, forceCountry });
  }

  if (cmd === 'init-login') return cmdInitLogin();
  if (cmd === 'capture-redeem') return cmdCaptureRedeem();
  if (cmd === 'capture-arsal') return cmdCaptureArsal();

  if (cmd === 'arsal-test') {
    const code = args.slice(1).find((a) => /^[A-Za-z0-9]{4,}$/.test(a) && !a.startsWith('--'));
    const real = args.includes('--real');
    const playerArg = args.find((a) => /^--player=\d+$/.test(a));
    const playerId = playerArg ? playerArg.split('=')[1] : null;
    if (!code) { printUsage(); process.exit(1); }
    return cmdArsalTest({ code, visible, real, playerId, proxy, forceCountry });
  }

  printUsage();
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => { console.error('[!] ' + (e.stack || e.message || e)); process.exit(1); });
}

module.exports = { MidasOracle };
