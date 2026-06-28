/**
 * AI駆動ユニバーサルスクレイパー (v2)
 *
 * 1. ページを開いて操作要素(select/button)を実DOMから抽出
 * 2. AIに「どれが年度/学部/検索ボタンか」を判断させる
 * 3. 学部selectの全optionを実DOMからループ
 * 4. 各学部で検索→結果テーブルをAI解析(初回のみ)→抽出→ページネーション
 *
 * 自己診断ログを厚めに出すので、一晩DRY RUNすれば各校の成否原因が分かる。
 */
import * as cheerio from 'cheerio';
import { withPage } from '../lib/browser.js';
import { analyzeForm, analyzeStructure, extractCourses } from '../lib/ai_analyzer.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const DAY_MAP = { '月':'月曜日','火':'火曜日','水':'水曜日','木':'木曜日','金':'金曜日','土':'土曜日' };
const z2h = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

function parseDayPeriod(raw) {
  const n = z2h(raw || '');
  const m = n.match(/([月火水木金土])/);
  const p = n.match(/(\d)/);
  if (!m || !p) return {};
  return { dayOfWeek: DAY_MAP[m[1]] ?? null, period: parseInt(p[1]) || null };
}

const L = (u, msg) => console.log(`[universal:${u}] ${msg}`);

export async function scrapeUniversal(univConfig, year = 2026) {
  const { name: u, syllabusBase } = univConfig;
  L(u, `開始 → ${syllabusBase}`);
  const allCourses = [];
  const seen = new Set();

  await withPage(async (page) => {
    // 1. ページを開く
    try {
      await page.goto(syllabusBase, { waitUntil: 'networkidle', timeout: 45000 });
    } catch {
      await page.goto(syllabusBase, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    await page.waitForTimeout(4000);

    // 2. 操作要素を実DOMから抽出
    const elements = await extractInteractiveElements(page);
    L(u, `select数=${elements.selects.length} button数=${elements.buttons.length}`);
    if (elements.selects.length === 0 && elements.buttons.length === 0) {
      L(u, `操作要素なし(SPA or 別ページ) — スキップ`);
      return;
    }

    // 3. AIにフォーム構造を判断させる
    let formPlan;
    try {
      formPlan = await analyzeForm(u, elements);
      L(u, `AI判定: 年度=${formPlan.yearSelectName} 学部=${formPlan.facultySelectName} 検索=${formPlan.searchButtonSelector}`);
    } catch (e) {
      L(u, `AIフォーム解析失敗: ${e.message}`);
      return;
    }

    // 4. 学部optionを実DOMから取得
    let faculties = [];
    if (formPlan.facultySelectName) {
      faculties = await page.evaluate((name) => {
        const s = document.querySelector(`select[name="${name}"]`);
        if (!s) return [];
        return [...s.options]
          .filter(o => o.value && !['', ':', '-1', '00', '0'].includes(o.value) && o.text.trim().length > 1)
          .map(o => ({ value: o.value, label: o.text.trim().slice(0, 24) }));
      }, formPlan.facultySelectName).catch(() => []);
    }
    L(u, `学部数=${faculties.length}`);

    let structure = null;

    const runOnce = async (facValue, facLabel) => {
      // 検索ページに戻る
      try {
        await page.goto(syllabusBase, { waitUntil: 'networkidle', timeout: 45000 });
      } catch {
        await page.goto(syllabusBase, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
      await page.waitForTimeout(1500);

      // 年度設定
      if (formPlan.yearSelectName) {
        await page.evaluate(({ name, y }) => {
          const s = document.querySelector(`select[name="${name}"]`);
          if (s) { const o = [...s.options].find(x => x.value === String(y)); if (o) s.value = String(y); }
        }, { name: formPlan.yearSelectName, y: year }).catch(() => {});
      }
      // 学部設定
      if (facValue && formPlan.facultySelectName) {
        await page.selectOption(`select[name="${formPlan.facultySelectName}"]`, facValue).catch(() => {});
      }
      // 検索ボタンクリック
      const btn = page.locator(formPlan.searchButtonSelector).first();
      if (await btn.count() > 0) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
          btn.click().catch(() => {}),
        ]).catch(() => {});
      }
      await page.waitForTimeout(2000);

      // 結果テーブル構造をAI解析(初回のみ)
      if (!structure) {
        const html = await page.content();
        try {
          structure = await analyzeStructure(u, html);
          L(u, `テーブル解析: table="${structure.tableSelector}" name列=${structure.columns?.name} 曜時限列=${structure.columns?.dayPeriod}`);
        } catch (e) {
          L(u, `テーブル解析失敗: ${e.message}`);
          return;
        }
      }

      await scrapePages(page, structure, u, facLabel, year, allCourses, seen);
    };

    if (faculties.length > 0) {
      for (const fac of faculties) {
        const before = allCourses.length;
        try {
          await runOnce(fac.value, fac.label);
          L(u, `${fac.label}: +${allCourses.length - before} (計${allCourses.length})`);
        } catch (e) {
          L(u, `${fac.label} 失敗: ${e.message}`);
        }
        await page.waitForTimeout(600);
      }
    } else {
      // 学部なし: 単純検索
      await runOnce(null, '');
    }
  });

  L(u, `合計 ${allCourses.length}科目`);
  return allCourses;
}

async function extractInteractiveElements(page) {
  return page.evaluate(() => {
    const selects = [...document.querySelectorAll('select')].slice(0, 15).map(s => ({
      name: s.name, id: s.id,
      sampleOptions: [...s.options].slice(0, 5).map(o => `${o.value}:${o.text.trim()}`.slice(0, 30)),
      optionCount: s.options.length,
    }));
    const buttons = [...document.querySelectorAll('input[type="submit"],input[type="button"],button')]
      .slice(0, 15).map(b => ({
        tag: b.tagName, id: b.id,
        value: b.value || '', text: (b.textContent || '').trim().slice(0, 20),
        selector: b.id ? `#${b.id}` : (b.value ? `input[value="${b.value}"]` : b.tagName.toLowerCase()),
      }));
    return { selects, buttons };
  });
}

async function scrapePages(page, structure, u, faculty, year, allCourses, seen) {
  if (!structure?.tableSelector) return;
  let pageNum = 1;
  while (true) {
    const html = await page.content();
    const $ = cheerio.load(html);
    const raw = extractCourses($, structure, u, faculty, year);

    let added = 0;
    for (const c of raw) {
      const { dayOfWeek, period } = parseDayPeriod(c.dayPeriodRaw);
      if (!dayOfWeek || !period || !c.name) continue;
      const slotKey = buildSlotKey({ universityName: u, dayJa: dayOfWeek, period, subject: c.name });
      const dedup = slotKey + c.instructor;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      const lectureId = buildLectureId({ universityName: u, dayJa: dayOfWeek, period, subject: c.name });
      allCourses.push({
        universityName: u, year, semester: 'unknown',
        name: c.name, nameNorm: normalizeSubject(c.name),
        dayOfWeek, period, periodEnd: period,
        room: c.room, instructor: c.instructor,
        instructorNorm: normalizeInstructor(c.instructor),
        faculty: c.faculty, credits: c.credits, description: '', textbooks: [],
        slotKey, lectureId,
        lectureIdWithInstructor: c.instructor
          ? buildLectureId({ universityName: u, dayJa: dayOfWeek, period, subject: c.name, instructor: c.instructor })
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
    await page.waitForTimeout(700);
    pageNum++;
    if (pageNum > 200) break;
  }
}
