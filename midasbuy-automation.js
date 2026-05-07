/**
 * Midasbuy PUBG Mobile UC - USER ID Automation Script
 *
 * Automates changing the Player ID on the Midasbuy PUBG Mobile UC purchase form.
 * Site: https://www.midasbuy.com/midasbuy/eg/buy/pubgm
 *
 * Requirements: npm install playwright && npx playwright install chromium
 *
 * Usage:
 *   node midasbuy-automation.js <USER_ID> [--visible] [--keep-open]
 *
 * Examples:
 *   node midasbuy-automation.js 5234567890
 *   node midasbuy-automation.js 5234567890 --visible
 */

const { chromium } = require('playwright');
const TARGET_URL = 'https://www.midasbuy.com/midasbuy/eg/buy/pubgm?from=self.midasbuy_saas';
const VIEWPORT = { width: 1920, height: 1080 };

function parseArgs() {
  const args = process.argv.slice(2);
  const userId = args.find(a => /^\d+$/.test(a));
  return {
    userId,
    flags: {
      headless: !args.includes('--visible'),
      keepOpen: args.includes('--keep-open'),
    }
  };
}

async function changeUserId(userId, flags) {
  console.log('[+] Midasbuy USER ID Automation');
  console.log('    Target ID: ' + userId);
  console.log('    Headless:  ' + flags.headless);
  console.log('');

  const browser = await chromium.launch({
    headless: flags.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'en-US'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    // STEP 1: Navigate
    console.log('[1/5] Loading page...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    console.log('  OK - Page loaded');

    // STEP 2: Dismiss overlays
    console.log('[2/5] Dismissing overlays...');

    // 2a. PatFace full-screen ad overlay
    const patFaceClose = page.locator('.PatFacePopWrapper_close-btn__erWAb');
    if (await patFaceClose.isVisible({ timeout: 3000 }).catch(() => false)) {
      await patFaceClose.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(800);
      console.log('  OK - Ad overlay dismissed');
    }

    // JS fallback if overlay still present
    const stillBlocking = await page.evaluate(() => {
      const p = document.querySelector('[class*="PatFacePopWrapper"]');
      return p && window.getComputedStyle(p).display !== 'none';
    });
    if (stillBlocking) {
      await page.evaluate(() => {
        const el = document.querySelector('[class*="PatFacePopWrapper"]');
        if (el) el.remove();
      });
      console.log('  OK - Ad overlay removed via JS');
      await page.waitForTimeout(500);
    }

    // 2b. Cookie consent
    const cookieBtn = page.locator('.PopCookie_btn_wrap__DrN5M').first();
    if (await cookieBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cookieBtn.click({ force: true });
      await page.waitForTimeout(500);
      console.log('  OK - Cookie consent accepted');
    }

    // STEP 3: Open Player ID popup
    console.log('[3/5] Opening Player ID form...');
    const trigger = page.locator('.UserTabBox_use_tab_box__otkPd').first();
    await trigger.waitFor({ state: 'visible', timeout: 15000 });
    await trigger.click({ force: true });
    await page.waitForTimeout(500);
    if (await trigger.isVisible({ timeout: 2000 }).catch(() => false)) {
      await trigger.click({ force: true });
    }
    await page.waitForTimeout(3000);
    console.log('  OK - Player ID form opened');

    // STEP 4: Enter USER ID
    console.log('[4/5] Entering USER ID...');
    const placeholderText = 'معرف لاعب';
    const input = page.locator('input[placeholder*="' + placeholderText + '"]');
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.click({ force: true });
    await page.waitForTimeout(300);
    await input.fill('');
    await page.waitForTimeout(200);
    await input.type(userId, { delay: 20 });
    const entered = await input.inputValue();
    console.log('  OK - USER ID entered: "' + entered + '"');

    // STEP 5: Submit
    console.log('[5/5] Submitting...');
    const okBtn = page.locator('.Button_btn_wrap__utZqk').filter({ hasText: 'OK' });
    if (await okBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await okBtn.click({ force: true });
      console.log('  OK - Submitted via OK button');
    } else {
      await page.keyboard.press('Enter');
      console.log('  OK - Submitted via Enter key');
    }

    await page.waitForTimeout(3000);

    // Check result
    const state = await page.evaluate(() => {
      const r = [];
      const err = document.querySelector('[class*="error"]');
      if (err) {
        const t = err.textContent ? err.textContent.trim() : '';
        if (t) r.push({ type: 'error', text: t.substring(0, 200) });
      }
      const info = document.querySelectorAll('[class*="PlayerInfo"], [class*="nickname"], [class*="charac"]');
      for (const el of info) {
        const t = el.textContent ? el.textContent.trim() : '';
        if (t && el.getBoundingClientRect().width > 0) r.push({ type: 'player-info', text: t.substring(0, 200) });
      }
      const popup = document.querySelector('[class*="BindLoginPop_pop_mode_box"]');
      if (popup) {
        r.push({ type: 'popup', text: 'display=' + window.getComputedStyle(popup).display });
      }
      const reconfirm = document.querySelector('[class*="ReconfirmPaymentPop"]');
      if (reconfirm && window.getComputedStyle(reconfirm).display !== 'none') {
        r.push({ type: 'reconfirm', text: 'Reconfirm dialog visible' });
      }
      return r;
    });

    console.log('\n[+] RESULT:');
    if (state.length === 0) {
      console.log('  No visible state change (expected for test IDs)');
    }
    for (const s of state) {
      console.log('  [' + s.type + '] ' + s.text);
    }

    await page.screenshot({ path: '/tmp/midasbuy_result.png' });
    console.log('\n[+] Screenshot: /tmp/midasbuy_result.png');
    console.log('[+] Done');

  } catch (err) {
    console.error('\n[!] Error: ' + err.message);
    await page.screenshot({ path: '/tmp/midasbuy_error.png' }).catch(() => {});
  } finally {
    if (!flags.keepOpen) await browser.close();
    console.log('[+] Browser closed');
  }
}

const { userId, flags } = parseArgs();
if (!userId) {
  console.log('Usage: node midasbuy-automation.js <USER_ID> [--visible] [--keep-open]');
  process.exit(1);
}
changeUserId(userId, flags);

