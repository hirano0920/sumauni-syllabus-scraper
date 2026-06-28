import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';

let _browser = null;
const SCREENSHOT_DIR = '/tmp/scraper-screenshots';

export async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return _browser;
}

export async function closeBrowser() {
  if (_browser) { await _browser.close(); _browser = null; }
}

export async function withPage(fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; SmartUni-Bot/1.0)',
    locale: 'ja-JP',
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** ページを開いてHTMLとスクリーンショットを返す */
export async function fetchPage(url, label = 'page', { waitFor = 'networkidle', timeout = 30000 } = {}) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: waitFor, timeout });

    // デバッグ用スクリーンショット
    if (process.env.PLAYWRIGHT_SCREENSHOT === '1') {
      await mkdir(SCREENSHOT_DIR, { recursive: true });
      const safe = label.replace(/[^a-zA-Z0-9　-鿿]/g, '_').slice(0, 50);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/${safe}.png`, fullPage: true });
      console.log(`  [screenshot] ${safe}.png`);
    }

    return page.content();
  });
}
