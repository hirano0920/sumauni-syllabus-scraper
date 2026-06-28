/**
 * AI自動解析ユニバーサルスクレイパー
 *
 * 流れ:
 * 1. Playwrightでシラバスページを開く
 * 2. HTMLをClaude APIに渡して構造を自動解析
 * 3. 解析結果のセレクタでページを全件スクレイピング
 * 4. ページネーションも自動処理
 *
 * これにより大学ごとのセレクタ手書きが不要になる。
 */
import * as cheerio from 'cheerio';
import { withPage } from '../lib/browser.js';
import { analyzeStructure, extractCourses } from '../lib/ai_analyzer.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const DAY_MAP = {
  '月':'月曜日','火':'火曜日','水':'水曜日','木':'木曜日','金':'金曜日','土':'土曜日',
  '月曜日':'月曜日','火曜日':'火曜日','水曜日':'水曜日','木曜日':'木曜日','金曜日':'金曜日','土曜日':'土曜日',
};
const z2h = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

function parseDayPeriod(raw) {
  const n = z2h(raw || '');
  const m = n.match(/([月火水木金土])/);
  const p = n.match(/(\d)/);
  if (!m || !p) return {};
  return { dayOfWeek: DAY_MAP[m[1]] ?? null, period: parseInt(p[1]) || null };
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (/春|前期|1学期/.test(raw)) return 'spring';
  if (/秋|後期|2学期/.test(raw)) return 'fall';
  if (/通年/.test(raw)) return 'full';
  return 'unknown';
}

export async function scrapeUniversal(univConfig, year = 2026) {
  const { name: universityName, syllabusBase } = univConfig;
  console.log(`[universal] ${universityName} 開始`);

  const allCourses = [];
  const seen = new Set();
  let structure = null;

  await withPage(async (page) => {
    // 1. ページを開く
    await page.goto(syllabusBase, { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(3000);

    // 2. 全件表示になるよう最初の検索を試みる（年度セレクトがあれば設定）
    await page.evaluate((y) => {
      const yearSels = ['select[name*="nendo"], select[name*="year"], select[name*="Year"], select[name*="bussinessyear"]']
        .flatMap(s => [...document.querySelectorAll(s)]);
      for (const sel of yearSels) {
        const opt = [...sel.options].find(o => o.value === String(y));
        if (opt) sel.value = String(y);
      }
    }, year).catch(() => {});

    // 検索ボタンがあればクリック
    const searchBtn = page.locator('input[type="submit"], input[value*="検索"], button:has-text("検索")').first();
    if (await searchBtn.count() > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
        searchBtn.click(),
      ]).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // 3. 最初のページのHTMLをAIに解析させる
    const html = await page.content();
    try {
      structure = await analyzeStructure(universityName, html);
      console.log(`[universal] ${universityName} AI解析完了: table="${structure.tableSelector}" name列=${structure.columns.name} 曜時限列=${structure.columns.dayPeriod}`);
    } catch (e) {
      console.warn(`[universal] ${universityName} AI解析失敗: ${e.message}`);
      return;
    }

    // 4. 解析結果のセレクタで全ページをスクレイピング
    let pageNum = 1;
    while (true) {
      const pageHtml = await page.content();
      const $ = cheerio.load(pageHtml);
      const rawCourses = extractCourses($, structure, universityName, '', year);

      let added = 0;
      for (const c of rawCourses) {
        const { dayOfWeek, period } = parseDayPeriod(c.dayPeriodRaw);
        if (!dayOfWeek || !period || !c.name) continue;

        const slotKey = buildSlotKey({ universityName, dayJa: dayOfWeek, period, subject: c.name });
        const dedupKey = slotKey + c.instructor;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const lectureId = buildLectureId({ universityName, dayJa: dayOfWeek, period, subject: c.name });
        const lectureIdWithInstructor = c.instructor
          ? buildLectureId({ universityName, dayJa: dayOfWeek, period, subject: c.name, instructor: c.instructor })
          : lectureId;

        allCourses.push({
          universityName, year,
          semester: normalizeSemester(''),
          name: c.name, nameNorm: normalizeSubject(c.name),
          dayOfWeek, period, periodEnd: period,
          room: c.room, instructor: c.instructor,
          instructorNorm: normalizeInstructor(c.instructor),
          faculty: c.faculty, credits: c.credits,
          description: '', textbooks: [],
          slotKey, lectureId, lectureIdWithInstructor,
          cmsType: 'universal_ai', sourceUrl: syllabusBase,
        });
        added++;
      }

      console.log(`[universal] ${universityName} page=${pageNum} +${added} (計${allCourses.length})`);
      if (added === 0) break;

      // 次ページ
      if (!structure.pagination?.nextSelector) break;
      const nextBtn = page.locator(structure.pagination.nextSelector).first();
      if (await nextBtn.count() === 0) break;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
        nextBtn.click(),
      ]).catch(() => {});
      await page.waitForTimeout(1000);
      pageNum++;
      if (pageNum > 200) break;
    }
  });

  console.log(`[universal] ${universityName} 合計 ${allCourses.length}科目`);
  return allCourses;
}
