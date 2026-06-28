/**
 * AI自動解析ユニバーサルスクレイパー
 *
 * 流れ:
 * 1. Playwrightでシラバスページを開く
 * 2. HTMLをDeepSeek APIに渡して構造を自動解析(セレクタ・列番号・学部セレクト・ページネーション)
 * 3. 学部セレクトがあれば全学部をループ、各学部で検索→全ページスクレイピング
 * 4. なければ単純検索→全ページ
 */
import * as cheerio from 'cheerio';
import { withPage } from '../lib/browser.js';
import { analyzeStructure, extractCourses } from '../lib/ai_analyzer.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const DAY_MAP = {
  '月':'月曜日','火':'火曜日','水':'水曜日','木':'木曜日','金':'金曜日','土':'土曜日',
};
const z2h = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

function parseDayPeriod(raw) {
  const n = z2h(raw || '');
  const m = n.match(/([月火水木金土])/);
  const p = n.match(/(\d)/);
  if (!m || !p) return {};
  return { dayOfWeek: DAY_MAP[m[1]] ?? null, period: parseInt(p[1]) || null };
}

export async function scrapeUniversal(univConfig, year = 2026) {
  const { name: universityName, syllabusBase } = univConfig;
  console.log(`[universal] ${universityName} 開始`);

  const allCourses = [];
  const seen = new Set();

  await withPage(async (page) => {
    await page.goto(syllabusBase, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // 年度セレクトを設定
    await setYear(page, year);

    // 初回検索（全件 or デフォルト表示）してAIに構造解析させる
    await clickSearch(page);
    const firstHtml = await page.content();

    let structure;
    try {
      structure = await analyzeStructure(universityName, firstHtml);
      console.log(`[universal] ${universityName} AI解析: table="${structure.tableSelector}" name列=${structure.columns?.name} 曜時限列=${structure.columns?.dayPeriod} 学部select=${structure.form?.facultySelect || 'なし'}`);
    } catch (e) {
      console.warn(`[universal] ${universityName} AI解析失敗: ${e.message}`);
      return;
    }

    const facultySelect = structure.form?.facultySelect;

    if (facultySelect) {
      // 学部セレクトの全optionを取得してループ
      const faculties = await page.evaluate((sel) => {
        const s = document.querySelector(`select[name="${sel}"]`);
        if (!s) return [];
        return [...s.options]
          .filter(o => o.value && o.value !== ':' && o.value !== '-1' && o.value !== '')
          .map(o => ({ value: o.value, label: o.text.trim().slice(0, 20) }));
      }, facultySelect).catch(() => []);

      console.log(`[universal] ${universityName} 学部数: ${faculties.length}`);

      if (faculties.length === 0) {
        await scrapePages(page, structure, universityName, '', year, allCourses, seen);
      } else {
        for (const fac of faculties) {
          try {
            await page.goto(syllabusBase, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
            await page.waitForTimeout(1500);
            await setYear(page, year);
            await page.selectOption(`select[name="${facultySelect}"]`, fac.value).catch(() => {});
            await clickSearch(page);
            const before = allCourses.length;
            await scrapePages(page, structure, universityName, fac.label, year, allCourses, seen);
            console.log(`[universal] ${universityName} ${fac.label}: +${allCourses.length - before} (計${allCourses.length})`);
          } catch (e) {
            console.warn(`[universal] ${universityName} ${fac.label} 失敗: ${e.message}`);
          }
          await page.waitForTimeout(800);
        }
      }
    } else {
      await scrapePages(page, structure, universityName, '', year, allCourses, seen);
    }
  });

  console.log(`[universal] ${universityName} 合計 ${allCourses.length}科目`);
  return allCourses;
}

async function setYear(page, year) {
  await page.evaluate((y) => {
    const sels = [...document.querySelectorAll('select')].filter(s =>
      /nendo|year|Year|bussinessyear|年度/i.test(s.name + s.id));
    for (const sel of sels) {
      const opt = [...sel.options].find(o => o.value === String(y));
      if (opt) sel.value = String(y);
    }
  }, year).catch(() => {});
}

async function clickSearch(page) {
  const btn = page.locator('input[type="submit"], input[value*="検索"], button:has-text("検索"), input[value*="Search"]').first();
  if (await btn.count() > 0) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      btn.click().catch(() => {}),
    ]).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function scrapePages(page, structure, universityName, faculty, year, allCourses, seen) {
  let pageNum = 1;
  while (true) {
    const html = await page.content();
    const $ = cheerio.load(html);
    const raw = extractCourses($, structure, universityName, faculty, year);

    let added = 0;
    for (const c of raw) {
      const { dayOfWeek, period } = parseDayPeriod(c.dayPeriodRaw);
      if (!dayOfWeek || !period || !c.name) continue;
      const slotKey = buildSlotKey({ universityName, dayJa: dayOfWeek, period, subject: c.name });
      const dedup = slotKey + c.instructor;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      const lectureId = buildLectureId({ universityName, dayJa: dayOfWeek, period, subject: c.name });
      allCourses.push({
        universityName, year, semester: 'unknown',
        name: c.name, nameNorm: normalizeSubject(c.name),
        dayOfWeek, period, periodEnd: period,
        room: c.room, instructor: c.instructor,
        instructorNorm: normalizeInstructor(c.instructor),
        faculty: c.faculty, credits: c.credits,
        description: '', textbooks: [],
        slotKey, lectureId,
        lectureIdWithInstructor: c.instructor
          ? buildLectureId({ universityName, dayJa: dayOfWeek, period, subject: c.name, instructor: c.instructor })
          : lectureId,
        cmsType: 'universal_ai', sourceUrl: page.url(),
      });
      added++;
    }

    if (added === 0) break;
    if (!structure.pagination?.nextSelector) break;
    const next = page.locator(structure.pagination.nextSelector).first();
    if (await next.count() === 0) break;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      next.click().catch(() => {}),
    ]).catch(() => {});
    await page.waitForTimeout(800);
    pageNum++;
    if (pageNum > 200) break;
  }
}
