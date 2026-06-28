/**
 * Playwrightブラウザ管理。
 * JavaScriptレンダリング必須のシラバスシステム向け。
 */
import { chromium } from 'playwright';

let _browser = null;

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
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

/** 新しいページを開いてコンテンツ取得後に閉じる */
export async function withPage(fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'SmartUni-SyllabusBot/1.0 (contact: info@sumauni.app; educational use)',
    locale: 'ja-JP',
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** ページを開いてHTMLを返す */
export async function fetchRenderedHtml(url, { waitFor = 'networkidle', timeout = 30000 } = {}) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: waitFor, timeout });
    return page.content();
  });
}
