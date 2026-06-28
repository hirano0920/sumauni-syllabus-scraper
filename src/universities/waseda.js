/**
 * 早稲田大学 シラバス — LiveCampus (wsl.waseda.jp)
 *
 * 方式: 学部コード×学期 でPOSTして table.ct-common.ct-sirabasu をパース
 * フォーム: POST https://www.wsl.waseda.jp/syllabus/index.php
 *   p_gakubu: 学部コード
 *   p_gakki:  0=通年 1=春 2=秋
 *   p_nendo:  年度(2025)
 *   p_number: 表示件数(100)
 */
import * as cheerio from 'cheerio';
import { withPage } from '../lib/browser.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '早稲田大学';
const SEARCH_URL = 'https://www.wsl.waseda.jp/syllabus/JAA101.php';
const POST_URL   = 'https://www.wsl.waseda.jp/syllabus/index.php';

// 学部コード（reconで取得済み + 全学部を補完）
const FACULTIES = [
  { code: '111973', name: '政治経済学部' },
  { code: '121973', name: '法学部' },
  { code: '151949', name: '教育学部' },
  { code: '161973', name: '商学部' },
  { code: '181966', name: '社会科学部' },
  { code: '211920', name: '文化構想学部' },
  { code: '221920', name: '文学部' },
  { code: '231920', name: '基幹理工学部' },
  { code: '241920', name: '創造理工学部' },
  { code: '251920', name: '先進理工学部' },
  { code: '261920', name: '人間科学部' },
  { code: '271920', name: 'スポーツ科学部' },
  { code: '281920', name: '国際教養学部' },
  // 全学オープン科目
  { code: '999901', name: '全学オープン' },
];

const SEMESTERS = [
  { code: '1', label: '春学期' },
  { code: '2', label: '秋学期' },
];

export async function scrapeAll(fetcher, year = 2025) {
  console.log(`[waseda] 開始 year=${year}`);
  const allCourses = [];
  const seen = new Set();

  return withPage(async (page) => {
    // トップページで初期Cookie/セッションを確立
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 30000 });

    for (const faculty of FACULTIES) {
      for (const sem of SEMESTERS) {
        try {
          const courses = await scrapeFacultySemester(page, year, faculty, sem, seen);
          allCourses.push(...courses);
          console.log(`[waseda] ${faculty.name} ${sem.label}: ${courses.length}科目 (計${allCourses.length})`);
        } catch (e) {
          console.warn(`[waseda] ${faculty.name} ${sem.label} 失敗: ${e.message}`);
        }
        await page.waitForTimeout(1200); // 礼儀
      }
    }

    console.log(`[waseda] 合計 ${allCourses.length}科目`);
    return allCourses;
  });
}

async function scrapeFacultySemester(page, year, faculty, sem, seen) {
  const courses = [];
  let pageNum = 1;

  while (true) {
    // POSTリクエスト: ナビゲーション完了を待ちながらフォームをsubmit
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      page.evaluate(({ postUrl, params }) => {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = postUrl;
        for (const [k, v] of Object.entries(params)) {
          const input = document.createElement('input');
          input.name = k; input.value = v; form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
      }, {
        postUrl: POST_URL,
        params: {
          p_nendo: `${year}`,
          p_gakubu: faculty.code,
          p_gakki: sem.code,
          p_wday: '',
          p_jigen: '',
          p_gengo: '0',
          p_number: '100',
          p_page: `${pageNum}`,
          p_action: 'next',
        },
      }),
    ]);

    const html = await page.content();
    const finalUrl = page.url();
    const $ = cheerio.load(html);

    // デバッグ: POST後の状態を確認（最初の学部・1ページ目のみ）
    if (pageNum === 1 && faculty.code === '111973') {
      console.log(`[waseda] POST後URL: ${finalUrl}`);
      console.log(`[waseda] POST後タイトル: ${await page.title()}`);
      // 全テーブルのclass/rows
      const tables = $('table').map((_, t) => `class="${$(t).attr('class')}" rows=${$(t).find('tr').length}`).get();
      console.log(`[waseda] テーブル一覧:\n${tables.join('\n') || '(なし)'}`);
      // ページ内テキスト冒頭
      const bodyText = $('body').text().replace(/\s+/g, ' ').slice(0, 400);
      console.log(`[waseda] body冒頭: ${bodyText}`);
    }

    const rows = $('table.ct-common.ct-sirabasu tbody tr, table.ct-sirabasu tbody tr');
    if (rows.length === 0) break;

    let added = 0;
    rows.each((_, tr) => {
      const course = parseRow($, tr, faculty.name, year);
      if (course && !seen.has(course.slotKey + course.instructor)) {
        seen.add(course.slotKey + course.instructor);
        courses.push(course);
        added++;
      }
    });

    // 次ページがあるか（「次へ」リンク）
    const hasNext = $('a:contains("次"), a:contains("次へ"), a:contains(">")').length > 0 && added > 0;
    if (!hasNext || added === 0) break;
    pageNum++;
    if (pageNum > 50) break;
  }

  return courses;
}

function parseRow($, tr, faculty, year) {
  const cells = $(tr).find('td');
  if (cells.length < 6) return null;

  // 早稲田LiveCampusの列順（実際に確認が必要、典型的な並び）
  // 科目コード | 科目名 | 担当教員 | 学期 | 曜日時限 | 教室 | 単位
  const name = $(cells[1]).text().trim() || $(cells[0]).text().trim();
  const instructor = $(cells[2]).text().trim();
  const semRaw = $(cells[3]).text().trim();
  const dayPeriodRaw = $(cells[4]).text().trim();
  const room = $(cells[5]).text().trim() || '';
  const credits = parseInt($(cells[6]).text().trim()) || 0;

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
    cmsType: 'livecampus_waseda',
    sourceUrl: POST_URL,
  };
}

const DAY_MAP = {
  '月': '月曜日', '火': '火曜日', '水': '水曜日',
  '木': '木曜日', '金': '金曜日', '土': '土曜日',
  '1': '月曜日', '2': '火曜日', '3': '水曜日',
  '4': '木曜日', '5': '金曜日',
};

function parseDayPeriod(raw) {
  // "月1限" / "火3" / "水曜日3限" / "月1・3" 等
  const m = raw.match(/([月火水木金土日１２３４５])/);
  const p = raw.match(/(\d)/);
  if (!m || !p) return {};
  return {
    dayOfWeek: DAY_MAP[m[1]] ?? null,
    period: parseInt(p[1]) || null,
  };
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (raw.includes('春') || raw.includes('夏') || raw.includes('1')) return 'spring';
  if (raw.includes('秋') || raw.includes('冬') || raw.includes('2')) return 'fall';
  return 'unknown';
}
