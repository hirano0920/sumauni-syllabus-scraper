/**
 * 筑波大学 KdB — Playwright版
 * https://kdb.tsukuba.ac.jp/
 * CSVダウンロード or テーブルスクレイピング
 */
import * as cheerio from 'cheerio';
import { withPage } from '../lib/browser.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '筑波大学';
const TOP_URL = 'https://kdb.tsukuba.ac.jp/';

export async function scrapeAll(fetcher, year = 2025) {
  console.log(`[tsukuba] Playwright起動 year=${year}`);

  return withPage(async (page) => {
    await page.goto(TOP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // 年度を設定（デフォルトが当年度なら不要）
    const yearSelect = page.locator('select[name*="nendo"], select[name*="year"], #nendo');
    if (await yearSelect.count() > 0) {
      await yearSelect.selectOption(`${year}`).catch(() => {});
    }

    // 全件検索ボタン or 検索ボタンをクリック
    await page.locator('input[type="submit"], button[type="submit"], input[value*="検索"], button:has-text("検索")').first().click();
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    const courses = [];
    let pageNum = 1;

    while (true) {
      const html = await page.content();
      const pageCourses = parseKdbTable(html, year);
      courses.push(...pageCourses);
      console.log(`[tsukuba] page=${pageNum} +${pageCourses.length} (計${courses.length})`);

      // 次ページ
      const nextBtn = page.locator('a:has-text("次"), a:has-text("Next"), a[rel="next"], .next a').first();
      if (await nextBtn.count() === 0) break;
      await nextBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 20000 });
      pageNum++;
      if (pageNum > 100) break; // 安全弁
    }

    console.log(`[tsukuba] 合計 ${courses.length}科目`);
    return courses;
  });
}

function parseKdbTable(html, year) {
  const $ = cheerio.load(html);
  const courses = [];

  $('table tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 4) return;

    // KdB列: 科目番号|科目名|単位|標準年次|実施学期|曜時限|教室|担当教員|...
    const name = $(cells[1]).text().trim() || $(cells[0]).text().trim();
    const dayPeriodRaw = $(cells[5]).text().trim() || $(cells[4]).text().trim();
    const room = $(cells[6]).text().trim() || '';
    const instructor = $(cells[7]).text().trim() || '';
    const credits = parseInt($(cells[2]).text().trim()) || 0;
    const semRaw = $(cells[4]).text().trim();

    if (!name || name.length < 2) return;

    const { dayOfWeek, period } = parseDayPeriod(dayPeriodRaw);
    if (!dayOfWeek || !period) return;

    const slotKey = buildSlotKey({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
    const lectureId = buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
    const lectureIdWithInstructor = instructor
      ? buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name, instructor })
      : lectureId;

    courses.push({
      universityName: UNIVERSITY_NAME, year,
      semester: normalizeSemester(semRaw),
      name, nameNorm: normalizeSubject(name),
      dayOfWeek, period, periodEnd: period,
      room, instructor, instructorNorm: normalizeInstructor(instructor),
      faculty: '', credits, description: '', textbooks: [],
      slotKey, lectureId, lectureIdWithInstructor,
      cmsType: 'kdb_tsukuba',
      sourceUrl: TOP_URL,
    });
  });

  return courses;
}

function parseDayPeriod(raw) {
  const dayMap = { '月':'月曜日','火':'火曜日','水':'水曜日','木':'木曜日','金':'金曜日','土':'土曜日','日':'日曜日' };
  const m = raw.match(/([月火水木金土日])/);
  const p = raw.match(/(\d)/);
  if (!m || !p) return {};
  return { dayOfWeek: dayMap[m[1]] ?? null, period: parseInt(p[1]) };
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (raw.includes('春') || raw.includes('1')) return 'spring';
  if (raw.includes('秋') || raw.includes('2')) return 'fall';
  return 'unknown';
}
