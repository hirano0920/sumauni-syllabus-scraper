/**
 * LiveCampus (NTTデータ) スクレイパー
 *
 * 共通URL構造:
 *   {base}?nendo={year}&gakki={semester}&youbi={day}&jigen={period}&...
 *   または REST 風: {base}/api/syllabus?...
 *
 * 実装手順:
 * 1. {base} にアクセスして学部・科目一覧ページのURL構造を確認
 * 2. 科目一覧ページを全ページ走査
 * 3. 各科目詳細ページから必要フィールドを抽出
 *
 * TODO: 大学ごとにURL構造が微妙に異なるため、
 *       最初に早稲田で確認してから他校に適用する
 */
import * as cheerio from 'cheerio';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

// 曜日マスター (LiveCampusのパラメータ値 → 日本語)
const DAY_PARAM_TO_JA = {
  '1': '月曜日', '2': '火曜日', '3': '水曜日',
  '4': '木曜日', '5': '金曜日', '6': '土曜日', '7': '日曜日',
  // 大学によって 0始まり or 別形式の場合あり — TODO: 要確認
};

/**
 * LiveCampus科目一覧ページのHTMLから科目リンク一覧を抽出する汎用パーサー。
 * 大学によってセレクタが微妙に異なる可能性あり。
 */
export function parseCourseListPage(html, baseUrl) {
  const $ = cheerio.load(html);
  const courses = [];

  // LiveCampusの一般的なテーブル構造
  // <table class="ct-vh"> or <table class="syllabus-list">
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 4) return;

    const link = $(cells[0]).find('a').first();
    const href = link.attr('href');
    if (!href) return;

    courses.push({
      detailUrl: new URL(href, baseUrl).toString(),
      nameRaw: link.text().trim() || $(cells[0]).text().trim(),
    });
  });

  return courses;
}

/**
 * LiveCampus科目詳細ページのHTMLから1科目分のデータを抽出。
 */
export function parseCourseDetailPage(html, { universityName, year, detailUrl }) {
  const $ = cheerio.load(html);

  // LiveCampusの詳細ページは <table> の th/td ペアで構成される
  const fields = {};
  $('table tr').each((_, tr) => {
    const th = $(tr).find('th').first().text().trim();
    const td = $(tr).find('td').first().text().trim();
    if (th && td) fields[th] = td;
  });

  // フィールド名は大学ごとに日本語表記が異なる — よく使われる候補を列挙
  const name = fields['授業科目名'] || fields['科目名'] || fields['講義名'] || '';
  const instructor = fields['担当教員'] || fields['教員名'] || fields['担当者'] || '';
  const faculty = fields['学部'] || fields['開講学部'] || fields['対象学部'] || '';
  const dayPeriodRaw = fields['曜日・時限'] || fields['曜日時限'] || fields['開講曜日・時限'] || '';
  const room = fields['教室'] || fields['使用教室'] || '';
  const credits = parseInt(fields['単位数'] || fields['単位'] || '0') || 0;
  const semester = fields['学期'] || fields['開講学期'] || '';
  const description = fields['授業概要'] || fields['概要'] || fields['授業の概要'] || '';

  // 教科書は複数行になることが多い
  const textbookRaw = fields['教科書'] || fields['使用教科書'] || '';
  const textbooks = parseTextbooks(textbookRaw);

  // 曜日・時限のパース（例: "月曜日 2時限" / "月2" / "月曜 2限"）
  const { dayOfWeek, period, periodEnd } = parseDayPeriod(dayPeriodRaw);

  if (!name || !dayOfWeek || !period) return null;

  const slotKey = buildSlotKey({ universityName, dayJa: dayOfWeek, period, subject: name });
  const lectureId = buildLectureId({ universityName, dayJa: dayOfWeek, period, subject: name });
  const lectureIdWithInstructor = instructor
    ? buildLectureId({ universityName, dayJa: dayOfWeek, period, subject: name, instructor })
    : lectureId;

  return {
    universityName,
    year,
    semester: normalizeSemester(semester),
    name,
    nameNorm: normalizeSubject(name),
    dayOfWeek,
    period,
    periodEnd: periodEnd ?? period,
    room,
    instructor,
    instructorNorm: normalizeInstructor(instructor),
    faculty,
    credits,
    description,
    textbooks,
    slotKey,
    lectureId,
    lectureIdWithInstructor,
    cmsType: 'livecampus',
    sourceUrl: detailUrl,
  };
}

// ---- 内部ユーティリティ ----

function parseDayPeriod(raw) {
  if (!raw) return {};
  // "月曜日 2時限" or "月2" or "月曜 2限" or "火・木 3時限"
  const dayMap = { '月': '月曜日', '火': '火曜日', '水': '水曜日', '木': '木曜日', '金': '金曜日', '土': '土曜日', '日': '日曜日' };
  const m = raw.match(/([月火水木金土日])/);
  const p = raw.match(/(\d+)\s*[時限]/);
  if (!m) return {};
  return {
    dayOfWeek: dayMap[m[1]] ?? null,
    period: p ? parseInt(p[1]) : null,
    periodEnd: null,
  };
}

function parseTextbooks(raw) {
  if (!raw || raw === 'なし' || raw === '特になし') return [];
  // ISBNパターン抽出を試みる
  const isbns = [...raw.matchAll(/978[-\s]?[0-9]{10}/g)].map((m) => m[0].replace(/[-\s]/g, ''));
  if (isbns.length > 0) {
    return isbns.map((isbn) => ({ isbn, title: raw.slice(0, 100), author: '' }));
  }
  return [{ title: raw.slice(0, 200), author: '', isbn: '' }];
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (raw.includes('春') || raw.includes('前期') || raw.includes('first')) return 'spring';
  if (raw.includes('秋') || raw.includes('後期') || raw.includes('second')) return 'fall';
  if (raw.includes('通年') || raw.includes('年間')) return 'full';
  return 'unknown';
}
