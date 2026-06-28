/**
 * 汎用偵察モード: 任意の大学シラバスサイトの構造を吐き出す。
 * フォーム/ボタン/ダウンロードリンク/テーブルを列挙してスクレイパー設計に使う。
 */
import { mkdir } from 'fs/promises';
import { withPage } from './browser.js';

export async function recon(name, url) {
  console.log(`\n[recon] ${name} → ${url}`);

  await withPage(async (page) => {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
    } catch (e) {
      console.log(`[recon] goto失敗(domcontentloadedで再試行): ${e.message}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    }

    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    const title = await page.title();
    console.log(`[recon] 最終URL: ${finalUrl}`);
    console.log(`[recon] タイトル: ${title}`);

    // ログイン画面かどうかの簡易判定
    const bodyText = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 500);
    const looksLogin = /ログイン|login|認証|パスワード|password|ユーザーID/i.test(bodyText);
    console.log(`[recon] ログイン画面っぽい: ${looksLogin}`);

    // フォーム
    const forms = await page.evaluate(() =>
      [...document.querySelectorAll('form')].map(f => ({
        id: f.id, action: f.action, method: f.method,
        selects: [...f.querySelectorAll('select')].map(s => ({
          name: s.name, id: s.id,
          options: [...s.options].slice(0, 6).map(o => `${o.value}:${o.text}`.slice(0, 30)),
        })),
      }))
    );
    console.log(`[recon] フォーム(${forms.length}):\n${JSON.stringify(forms, null, 1).slice(0, 1500)}`);

    // ボタン
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('input[type="button"],input[type="submit"],button,a.btn,a.button')]
        .map(b => `${b.tagName} id="${b.id}" value="${b.value || ''}" text="${(b.textContent || '').trim().slice(0, 20)}"`)
        .slice(0, 25)
    );
    console.log(`[recon] ボタン:\n${buttons.join('\n')}`);

    // ダウンロードリンク
    const downloads = await page.evaluate(() =>
      [...document.querySelectorAll('a,input,button')]
        .filter(el => /csv|excel|xlsx|download|ダウンロード|一覧出力/i.test((el.textContent || '') + (el.value || '') + (el.href || '') + el.id))
        .map(el => `${el.tagName} id="${el.id}" text="${((el.textContent || el.value) || '').trim().slice(0, 24)}" href="${el.href || ''}"`)
        .slice(0, 15)
    );
    console.log(`[recon] ダウンロード候補:\n${downloads.join('\n') || '(なし)'}`);

    // テーブル
    const tables = await page.evaluate(() =>
      [...document.querySelectorAll('table')].map(t =>
        `class="${t.className}" id="${t.id}" rows=${t.querySelectorAll('tr').length}`
      ).slice(0, 12)
    );
    console.log(`[recon] テーブル:\n${tables.join('\n') || '(なし)'}`);

    // スクリーンショット
    if (process.env.PLAYWRIGHT_SCREENSHOT === '1') {
      await mkdir('/tmp/scraper-screenshots', { recursive: true }).catch(() => {});
      const safe = name.replace(/[^a-zA-Z0-9一-鿿ぁ-ヿ]/g, '_').slice(0, 40);
      await page.screenshot({ path: `/tmp/scraper-screenshots/recon_${safe}.png`, fullPage: true });
      console.log(`[recon] スクリーンショット: recon_${safe}.png`);
    }
  });
}
