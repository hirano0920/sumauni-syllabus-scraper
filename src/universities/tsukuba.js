/**
 * 筑波大学 KdB — Playwright版
 * まずトップページのスクリーンショットを撮ってHTML構造を確認する
 */
import * as cheerio from 'cheerio';
import { withPage, fetchPage } from '../lib/browser.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '筑波大学';
const TOP_URL = 'https://kdb.tsukuba.ac.jp/';

export async function scrapeAll(fetcher, year = 2025) {
  console.log(`[tsukuba] Playwright起動 year=${year}`);

  return withPage(async (page) => {
    await page.goto(TOP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // スクリーンショット撮影 (デバッグ)
    const { mkdir } = await import('fs/promises');
    await mkdir('/tmp/scraper-screenshots', { recursive: true }).catch(() => {});
    if (process.env.PLAYWRIGHT_SCREENSHOT === '1') {
      await page.screenshot({ path: '/tmp/scraper-screenshots/tsukuba_top.png', fullPage: true });
      console.log('[tsukuba] スクリーンショット保存: tsukuba_top.png');
    }

    // ページのフォーム要素を確認
    const formHtml = await page.evaluate(() => {
      const form = document.querySelector('form');
      return form ? form.outerHTML.slice(0, 2000) : 'フォームなし';
    });
    console.log(`[tsukuba] フォーム: ${formHtml.slice(0, 300)}`);

    // テーブルの行数を確認
    const rowCount = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
    console.log(`[tsukuba] テーブル行数: ${rowCount}`);

    // 全テーブルのclass/idを確認
    const tableInfo = await page.evaluate(() =>
      [...document.querySelectorAll('table')].map(t => `class="${t.className}" id="${t.id}"`).join('\n')
    );
    console.log(`[tsukuba] テーブル一覧:\n${tableInfo}`);

    if (rowCount > 0) {
      const html = await page.content();
      return parseKdbTable(html, year);
    }

    // 検索ボタンを探してクリック
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('input[type="submit"], button')].map(b => `${b.tagName} value="${b.value || b.textContent}"`).join(', ')
    );
    console.log(`[tsukuba] ボタン一覧: ${buttons}`);

    return [];
  });
}

function parseKdbTable(html, year) {
  const $ = cheerio.load(html);
  const courses = [];

  $('table tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 4) return;

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
