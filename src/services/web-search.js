'use strict';

// Web search + page reading for the assistant, driven by Playwright.
// Uses the system Google Chrome when available (playwright-core ships no
// browsers), falling back to a Playwright-managed Chromium install.
// The browser is launched headless on demand and closed after 2 minutes idle.
//
// Search engine: Mojeek, which serves plain HTML results to automated
// browsers (Google/Bing/DDG all gate headless traffic behind bot checks).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let browserPromise = null;
let idleTimer = null;

function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = browserPromise;
    browserPromise = null;
    const b = await p?.catch(() => null);
    b?.close().catch(() => {});
  }, 120000);
  if (idleTimer.unref) idleTimer.unref();
}

async function launch() {
  const { chromium } = require('playwright-core');
  try { return await chromium.launch({ headless: true, channel: 'chrome', timeout: 25000 }); } catch {}
  try { return await chromium.launch({ headless: true, timeout: 25000 }); } catch {}
  throw new Error('Web search needs a browser — install Google Chrome (or run: npx playwright install chromium)');
}

async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) { bumpIdle(); return b; }
    browserPromise = null;
  }
  browserPromise = launch();
  bumpIdle();
  return browserPromise;
}

async function newPage() {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  return { page, close: () => ctx.close().catch(() => {}) };
}

async function searchWeb(query, maxResults = 6) {
  const { page, close } = await newPage();
  try {
    await page.goto('https://www.mojeek.com/search?q=' + encodeURIComponent(query),
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    const results = await page.$$eval('ul.results-standard li', (els) => els.map((el) => {
      const a = el.querySelector('h2 a.title, a.title');
      const sn = el.querySelector('p.s');
      return a ? { title: a.textContent.trim(), url: a.href, snippet: sn ? sn.textContent.trim() : '' } : null;
    }));
    return results.filter(Boolean).slice(0, maxResults);
  } finally {
    await close();
  }
}

async function readPage(url, maxChars = 9000) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be read');
  const { page, close } = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(400); // let late-rendering pages settle
    const title = await page.title();
    const text = await page.evaluate(() => {
      for (const sel of ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript']) {
        document.querySelectorAll(sel).forEach((n) => n.remove());
      }
      return (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    });
    return { url, title, text: text.slice(0, maxChars) };
  } finally {
    await close();
  }
}

module.exports = { searchWeb, readPage };
