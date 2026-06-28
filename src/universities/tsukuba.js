/**
 * 筑波大学 KdB
 * form#ut-SB0070-form を JS経由でsubmit → table.ut-list をパース
 */
import * as cheerio from 'cheerio';
import { mkdir } from 'fs/promises';
import { withPage } from '../lib/browser.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '筑波大学';
const TOP_URL = 'https://kdb.tsukuba.ac.jp/';

export async function scrapeAll(fetcher, year = 2025) {
  console.log(`[tsukuba] 開始 year=${year}`);
  const allCourses = [];

  await withPage(async (page) => {
    await page.goto(TOP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // ページ上の全ボタンをログ (デバッグ)
    const allButtons = await page.evaluate(() =>
      [...document.querySelectorAll('input, button, a')].filter(el =>
        el.type === 'submit' || el.type === 'button' || el.tagName === 'BUTTON' ||
        (el.tagName === 'A' && (el.textContent.includes('検索') || el.textContent.includes('search')))
      ).map(el => `${el.tagName} type="${el.type}" value="${el.value}" text="${el.textContent.trim().slice(0,20)}" id="${el.id}" class="${el.className.slice(0,30)}"`)
    );
    console.log(`[tsukuba] ボタン候補:\n${allButtons.join('\n')}`);

    // JS経由でフォームをsubmit (最も確実)
    await page.evaluate(() => {
      const form = document.querySelector('#ut-SB0070-form') || document.querySelector('form');
      if (form) form.submit();
    });
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    // スクリーンショット
    if (process.env.PLAYWRIGHT_SCREENSHOT === '1') {
      await mkdir('/tmp/scraper-screenshots', { recursive: true }).catch(() => {});
      await page.screenshot({ path: '/tmp/scraper-screenshots/tsukuba_after_submit.png', fullPage: false });
    }

    // 結果確認
    const rowCount = await page.locator('table.ut-list tr').count();
    console.log(`[tsukuba] submit後 行数: ${rowCount}`);

    // 最初の行の内容をログ
    if (rowCount > 0) {
      const firstRow = await page.locator('table.ut-list tr').first().innerText();
      console.log(`[tsukuba] 1行目: ${firstRow.slice(0, 200)}`);
    }

    let pageNum = 1;
    while (true) {
      const html = await page.content();
      const courses = parseTable(html, year);
      allCourses.push(...courses);
      console.log(`[tsukuba] page=${pageNum} +${courses.length} (計${allCourses.length})`);

      const nextLink = page.locator('a:has-text("次"), a:has-text("次へ"), .next a, [class*="next"] a').first();
      if (await nextLink.count() === 0) break;
      await nextLink.click();
      await page.waitForLoadState('networkidle', { timeout: 20000 });
      pageNum++;
      if (pageNum > 200) break;
    }
  });

  console.log(`[tsukuba] 合計 ${allCourses.length}科目`);
  return allCourses;
}

function parseTable(html, year) {
  const $ = cheerio.load(html);
  const courses = [];

  $('table.ut-list tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 4) return;

    const name = $(cells[1]).text().trim();
    const credits = parseInt($(cells[2]).text().trim()) || 0;
    const semRaw = $(cells[4]).text().trim();
    const dayPeriodRaw = $(cells[5]).text().trim();
    const room = $(cells[6]).text().trim() || '';
    const instructor = $(cells[7]).text().trim() || '';

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
      cmsType: 'kdb_tsukuba', sourceUrl: TOP_URL,
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
