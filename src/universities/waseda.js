/**
 * 早稲田大学 シラバス — LiveCampus
 *
 * 方式: Playwrightで実際にドロップダウンを選んで検索ボタンをクリック
 *   (CSRFトークン等の隠しフィールドを自動的に含めるため)
 *
 * フォーム id="cForm"、検索ボタン value=" 検  索 "
 * 結果テーブル: table.ct-common.ct-sirabasu
 */
import * as cheerio from 'cheerio';
import { withPage } from '../lib/browser.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '早稲田大学';
const SEARCH_URL = 'https://www.wsl.waseda.jp/syllabus/JAA101.php';

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
    for (const faculty of FACULTIES) {
      for (const sem of SEMESTERS) {
        try {
          // 毎回トップページから始める（セッション・隠しフィールドをリセット）
          await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 30000 });

          // 学部と学期をドロップダウンで選択
          await page.selectOption('select[name="p_gakubu"]', faculty.code);
          await page.selectOption('select[name="p_gakki"]', sem.code);

          // 検索ボタンをクリック + ナビゲーション待ち
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
            page.locator('input[value=" 検  索 "], input[value*="検索"]').first().click(),
          ]);

          let pageNum = 1;
          while (true) {
            const html = await page.content();
            const $ = cheerio.load(html);

            // 1ページ目のみデバッグ情報を出力
            if (pageNum === 1 && faculty.code === '111973') {
              const tables = $('table').map((_, t) =>
                `class="${$(t).attr('class')}" rows=${$(t).find('tr').length}`).get();
              console.log(`[waseda] デバッグ テーブル:\n${tables.slice(0,8).join('\n')}`);
              const firstRow = $('table').eq(1).find('tr').first().text().trim().slice(0, 200);
              console.log(`[waseda] 最初のテーブル1行目: ${firstRow}`);
            }

            // tbody なしの可能性があるため tr を直接取得
            const rows = $('table.ct-vh tr').filter((_, tr) => $(tr).find('td').length > 0);

            // デバッグ: 最初の行の内容と行数を確認
            if (pageNum === 1 && faculty.code === '111973') {
              console.log(`[waseda] td行数: ${rows.length}`);
              rows.first().find('td').each((i, td) => {
                console.log(`  [${i}] ${$(td).text().trim().slice(0, 30)}`);
              });
            }

            let added = 0;
            rows.each((_, tr) => {
              const course = parseRow($, tr, faculty.name, year);
              if (course && !seen.has(course.slotKey + course.instructor)) {
                seen.add(course.slotKey + course.instructor);
                allCourses.push(course);
                added++;
              }
            });

            // 次ページへのリンクを探す
            const nextBtn = page.locator('a:has-text("次"), input[value*="次"]').first();
            if (await nextBtn.count() === 0 || added === 0) break;
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }),
              nextBtn.click(),
            ]);
            pageNum++;
            if (pageNum > 50) break;
          }

          console.log(`[waseda] ${faculty.name} ${sem.label}: (計${allCourses.length})`);
        } catch (e) {
          console.warn(`[waseda] ${faculty.name} ${sem.label} 失敗: ${e.message}`);
        }
        await page.waitForTimeout(800);
      }
    }

    console.log(`[waseda] 合計 ${allCourses.length}科目`);
    return allCourses;
  });
}

function parseRow($, tr, faculty, year) {
  const cells = $(tr).find('td');
  if (cells.length < 7) return null;

  // 確認済み列順: [0]年度 [1]コード [2]科目名 [3]担当教員 [4]開講学部 [5]学期 [6]曜日時限 [7]教室 [8]概要
  const name = $(cells[2]).text().trim();
  const instructor = $(cells[3]).text().trim();
  const semRaw = $(cells[5]).text().trim();
  const dayPeriodRaw = $(cells[6]).text().trim();
  const room = $(cells[7])?.text().trim() || '';
  const description = $(cells[8])?.text().trim() || '';
  const credits = 0; // 早稲田一覧には単位列なし

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
    faculty, credits, description, textbooks: [],
    slotKey, lectureId, lectureIdWithInstructor,
    cmsType: 'livecampus_waseda', sourceUrl: SEARCH_URL,
  };
}

const DAY_MAP = { '月':'月曜日','火':'火曜日','水':'水曜日','木':'木曜日','金':'金曜日','土':'土曜日' };

function parseDayPeriod(raw) {
  const m = raw.match(/([月火水木金土])/);
  const p = raw.match(/(\d)/);
  if (!m || !p) return {};
  return { dayOfWeek: DAY_MAP[m[1]] ?? null, period: parseInt(p[1]) || null };
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (raw.includes('春') || raw.includes('夏')) return 'spring';
  if (raw.includes('秋') || raw.includes('冬')) return 'fall';
  return 'unknown';
}
