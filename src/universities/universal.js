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
import { analyzeForm, analyzeStructure, analyzeJson, extractCourses } from '../lib/ai_analyzer.js';
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

  // SPAが叩くJSON APIレスポンスを傍受
  const jsonResponses = [];

  await withPage(async (page) => {
    page.on('response', async (res) => {
      try {
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const url = res.url();
        if (/analytics|gtag|google|sentry/i.test(url)) return;
        const body = await res.json().catch(() => null);
        if (body) jsonResponses.push({ url: url.slice(0, 120), body });
      } catch { /* ignore */ }
    });

    // 1. ページを開く
    try {
      await page.goto(syllabusBase, { waitUntil: 'networkidle', timeout: 45000 });
    } catch {
      await page.goto(syllabusBase, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }

    // SPA描画待ち: 操作要素が現れるまで最大15秒待つ
    await page.waitForSelector('select, input[type="submit"], button', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // 2. 操作要素を実DOMから抽出
    const elements = await extractInteractiveElements(page);
    L(u, `select数=${elements.selects.length} button数=${elements.buttons.length} JSON傍受=${jsonResponses.length}`);

    if (elements.selects.length === 0 && elements.buttons.length === 0) {
      // SPA: 傍受したJSON APIレスポンスから科目データを探す
      L(u, `操作要素なし(SPA) — JSON傍受モードへ`);
      const courses = await tryJsonMode(u, jsonResponses, year, seen);
      allCourses.push(...courses);
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

/**
 * SPA: 傍受したJSONレスポンスから科目配列を探してAIに構造解析させる。
 */
async function tryJsonMode(u, jsonResponses, year, seen) {
  const courses = [];
  if (jsonResponses.length === 0) {
    L(u, `JSON傍受0件 — 取得不可(検索操作が必要なSPA)`);
    return courses;
  }

  // 科目配列を含むレスポンスを探す(配列長が最大のもの)
  let best = null;
  for (const r of jsonResponses) {
    const arr = findLargestArray(r.body);
    if (arr && (!best || arr.length > best.arr.length)) best = { url: r.url, arr };
  }
  if (!best || best.arr.length < 3) {
    L(u, `JSON内に科目配列が見つからない(候補${jsonResponses.length}件)`);
    return courses;
  }
  L(u, `JSON配列発見: ${best.url} (${best.arr.length}件)`);

  // 最初の1件をAIに見せてフィールドパスを判定
  let fieldMap;
  try {
    fieldMap = await analyzeJson(u, best.arr[0]);
    L(u, `JSONフィールド判定: name=${fieldMap.name} day=${fieldMap.day} period=${fieldMap.period}`);
  } catch (e) {
    L(u, `JSON解析失敗: ${e.message}`);
    return courses;
  }

  for (const item of best.arr) {
    const name = `${getPath(item, fieldMap.name) ?? ''}`.trim();
    const dayRaw = `${getPath(item, fieldMap.day) ?? ''}`;
    const periodRaw = `${getPath(item, fieldMap.period) ?? ''}`;
    const instructor = `${getPath(item, fieldMap.instructor) ?? ''}`.trim();
    if (!name || name.length < 2) continue;

    const { dayOfWeek, period } = parseDayPeriod(`${dayRaw}${periodRaw}`);
    if (!dayOfWeek || !period) continue;

    const slotKey = buildSlotKey({ universityName: u, dayJa: dayOfWeek, period, subject: name });
    const dedup = slotKey + instructor;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    const lectureId = buildLectureId({ universityName: u, dayJa: dayOfWeek, period, subject: name });
    courses.push({
      universityName: u, year, semester: 'unknown',
      name, nameNorm: normalizeSubject(name),
      dayOfWeek, period, periodEnd: period,
      room: '', instructor, instructorNorm: normalizeInstructor(instructor),
      faculty: '', credits: 0, description: '', textbooks: [],
      slotKey, lectureId,
      lectureIdWithInstructor: instructor
        ? buildLectureId({ universityName: u, dayJa: dayOfWeek, period, subject: name, instructor })
        : lectureId,
      cmsType: 'universal_json', sourceUrl: best.url,
    });
  }
  L(u, `JSON抽出: ${courses.length}科目`);
  return courses;
}

// オブジェクト/配列を再帰探索して最も長い「オブジェクトの配列」を返す
function findLargestArray(obj, depth = 0) {
  if (depth > 6 || obj == null) return null;
  let best = null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) best = obj;
    for (const el of obj.slice(0, 50)) {
      const sub = findLargestArray(el, depth + 1);
      if (sub && (!best || sub.length > best.length)) best = sub;
    }
  } else if (typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const sub = findLargestArray(v, depth + 1);
      if (sub && (!best || sub.length > best.length)) best = sub;
    }
  }
  return best;
}

// "a.b.c" 形式のパスで値を取得
function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
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

    // 最初のページで0件のとき、最初の行の内容をログ出力して原因を特定
    if (pageNum === 1 && raw.length > 0 && raw.every(c => !parseDayPeriod(c.dayPeriodRaw).dayOfWeek)) {
      L(u, `0件デバッグ: raw=${raw.length} 最初の行: name="${raw[0]?.name}" dayPeriod="${raw[0]?.dayPeriodRaw}" instructor="${raw[0]?.instructor}"`);
    }

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

    // ページネーション: 複数の方法を試す
    const nextPageNum = pageNum + 1;
    // 方法1: AIが返したnextSelectorを試す
    let nextFound = false;
    if (structure.pagination?.nextSelector) {
      const next = page.locator(structure.pagination.nextSelector).first();
      if (await next.count() > 0) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
          next.click().catch(() => {}),
        ]).catch(() => {});
        nextFound = true;
      }
    }
    // 方法2: 次のページ番号リンクを探す (1/465 形式のページネーション)
    if (!nextFound) {
      const numLink = page.locator(`a:text-is("${nextPageNum}"), a:has-text("次"), a:has-text("Next")`).first();
      if (await numLink.count() > 0) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
          numLink.click().catch(() => {}),
        ]).catch(() => {});
        nextFound = true;
      }
    }
    if (!nextFound) break;
    await page.waitForTimeout(700);
    pageNum++;
    if (pageNum > 500) break;
  }
}
