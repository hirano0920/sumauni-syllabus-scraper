/**
 * 同志社大学 シラバス
 *
 * 方式: 学部コード×年度でPOST → table.search-table をパース
 * POST先: https://syllabus.doshisha.ac.jp/lectureWebResult.php
 * 結果テーブル: table.search-table (20件/ページ)
 *
 * 列順(reconのsearch-table__content 20行から推定、要確認):
 * 科目名 | 担当教員 | 学部 | 学期 | 曜日時限 | 教室 | 単位
 */
import * as cheerio from 'cheerio';
import { withPage } from '../lib/browser.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '同志社大学';
const SEARCH_URL = 'https://syllabus.doshisha.ac.jp/';
const POST_URL   = 'https://syllabus.doshisha.ac.jp/lectureWebResult.php';

// reconで確認した学部コード (subjectcd)
const FACULTIES = [
  { code: '1',   name: '神学部' },
  { code: '2',   name: '文学部' },
  { code: '3',   name: '社会学部' },
  { code: '4',   name: '法学部' },
  { code: '5',   name: '経済学部' },
  { code: '6',   name: '商学部' },
  { code: '7',   name: '政策学部' },
  { code: '8',   name: '文化情報学部' },
  { code: '9',   name: '理工学部' },
  { code: '10',  name: '生命医科学部' },
  { code: '11',  name: 'スポーツ健康科学部' },
  { code: '12',  name: '心理学部' },
  { code: '13',  name: 'グローバル・コミュニケーション学部' },
  { code: '14',  name: 'グローバル地域文化学部' },
  { code: '',    name: '全学共通' },
];

export async function scrapeAll(fetcher, year = 2025) {
  console.log(`[doshisha] 開始 year=${year}`);
  const allCourses = [];
  const seen = new Set();

  return withPage(async (page) => {
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 30000 });

    for (const faculty of FACULTIES) {
      try {
        const courses = await scrapeFaculty(page, year, faculty, seen);
        allCourses.push(...courses);
        console.log(`[doshisha] ${faculty.name}: ${courses.length}科目 (計${allCourses.length})`);
      } catch (e) {
        console.warn(`[doshisha] ${faculty.name} 失敗: ${e.message}`);
      }
      await page.waitForTimeout(1000);
    }

    console.log(`[doshisha] 合計 ${allCourses.length}科目`);
    return allCourses;
  });
}

async function scrapeFaculty(page, year, faculty, seen) {
  const courses = [];
  let pageNum = 1;

  while (true) {
    // フォームを選択してsubmit (毎ページ検索ページに戻る)
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // 最初の学部のみ: 年度の実際のoption一覧をログ出力
    if (pageNum === 1 && faculty.name === '神学部') {
      const yearOptions = await page.evaluate(() =>
        [...document.querySelectorAll('select[name="select_bussinessyear"] option')]
          .map(o => o.value).slice(-6)
      );
      console.log(`[doshisha] 年度options末尾: ${yearOptions.join(', ')}`);
    }

    // 年度セレクト (2025が存在しない場合は最新年度を使う)
    const yearSet = await page.evaluate((y) => {
      const sel = document.querySelector('select[name="select_bussinessyear"]');
      if (!sel) return false;
      const opt = [...sel.options].find(o => o.value === String(y));
      if (opt) { sel.value = String(y); return true; }
      // なければ最大値(最新年度)を選ぶ
      const values = [...sel.options].map(o => parseInt(o.value)).filter(n => !isNaN(n));
      sel.value = String(Math.max(...values));
      return `fallback:${sel.value}`;
    }, year);
    console.log(`[doshisha] ${faculty.name} 年度設定: ${yearSet}`);

    if (faculty.code) {
      await page.selectOption('select[name="subjectcd"]', faculty.code).catch(() => {});
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      page.locator('input[value="検索/Search"]').click(),
    ]);

    // 2ページ目以降: 検索後のページでページネーションリンクをクリック
    if (pageNum > 1) {
      const nextLink = page.locator(`a:has-text("${pageNum}"), a[href*="page=${pageNum}"]`).first();
      if (await nextLink.count() === 0) break;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }),
        nextLink.click(),
      ]);
    }

    const html = await page.content();
    const $ = cheerio.load(html);

    // デバッグ: 最初の学部・1ページ目のみ
    if (pageNum === 1 && faculty.name === '神学部') {
      const allTables = $('table').map((_, t) =>
        `class="${$(t).attr('class')}" rows=${$(t).find('tr').length}`).get();
      console.log(`[doshisha] テーブル:\n${allTables.join('\n') || '(なし)'}`);
      const bodyText = $('body').text().replace(/\s+/g, ' ').slice(0, 300);
      console.log(`[doshisha] body冒頭: ${bodyText}`);
    }

    // 確認済み: 同志社結果テーブルは class="result__table"
    const rows = $('table.result__table tr')
      .filter((_, tr) => $(tr).find('td').length >= 4);

    let added = 0;
    rows.each((_, tr) => {
      const course = parseRow($, tr, faculty.name, year);
      if (course && !seen.has(course.slotKey + course.instructor)) {
        seen.add(course.slotKey + course.instructor);
        courses.push(course);
        added++;
      }
    });

    if (added === 0) break;

    // 次ページ確認（ページリンクがあるか）
    const hasNext = $(`a:contains("${pageNum + 1}")`).length > 0;
    if (!hasNext) break;
    pageNum++;
    if (pageNum > 100) break;
  }

  return courses;
}

function parseRow($, tr, faculty, year) {
  const cells = $(tr).find('td');
  if (cells.length < 4) return null;

  // 列順は初回実行時のデバッグログで確定する
  // 典型的な同志社形式: 科目名|担当教員|学期|曜日時限|教室|単位
  const name = $(cells[0]).text().trim();
  const instructor = $(cells[1]).text().trim();
  const semRaw = $(cells[2]).text().trim();
  const dayPeriodRaw = $(cells[3]).text().trim();
  const room = $(cells[4])?.text().trim() || '';
  const credits = parseInt($(cells[5])?.text().trim()) || 0;

  if (!name || name.length < 2) return null;

  const { dayOfWeek, period } = parseDayPeriod(dayPeriodRaw);
  if (!dayOfWeek || !period) return null;

  const slotKey = buildSlotKey({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
  const lectureId = buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
  const lectureIdWithInstructor = instructor
    ? buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name, instructor })
    : lectureId;

  return {
    universityName: UNIVERSITY_NAME, year,
    semester: normalizeSemester(semRaw),
    name, nameNorm: normalizeSubject(name),
    dayOfWeek, period, periodEnd: period,
    room, instructor, instructorNorm: normalizeInstructor(instructor),
    faculty, credits, description: '', textbooks: [],
    slotKey, lectureId, lectureIdWithInstructor,
    cmsType: 'doshisha', sourceUrl: POST_URL,
  };
}

const DAY_MAP = { '月':'月曜日','火':'火曜日','水':'水曜日','木':'木曜日','金':'金曜日','土':'土曜日' };
const z2h = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

function parseDayPeriod(raw) {
  const n = z2h(raw);
  const m = n.match(/([月火水木金土])/);
  const p = n.match(/(\d)/);
  if (!m || !p) return {};
  return { dayOfWeek: DAY_MAP[m[1]] ?? null, period: parseInt(p[1]) || null };
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (raw.includes('春') || raw.includes('前期')) return 'spring';
  if (raw.includes('秋') || raw.includes('後期')) return 'fall';
  if (raw.includes('通年')) return 'full';
  return 'unknown';
}
