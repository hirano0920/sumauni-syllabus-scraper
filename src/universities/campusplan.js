/**
 * CampusPlan (システムインテグレータ社) スクレイパー
 *
 * 共通URL構造 (立命館など):
 *   https://syllabus.{univ}.ac.jp/syllabus/{year}/
 *   または https://syllabus.{univ}.ac.jp/search?year={year}&dept={deptCode}
 *
 * CampusPlanの特徴:
 * - 科目検索APIが /api/syllabus/search?... 形式で存在することが多い
 * - JSON レスポンスで科目リストを返す大学あり（スクレイピング不要になる場合も）
 * - 一覧は <table class="listTable"> 構造
 *
 * TODO: 立命館大学で確認してから他校適用
 */
import * as cheerio from 'cheerio';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

/**
 * CampusPlan一覧ページのHTMLから科目リンクを抽出。
 */
export function parseCourseListPage(html, baseUrl) {
  const $ = cheerio.load(html);
  const courses = [];

  // CampusPlanの一般的な構造: class="listTable" or class="syllabus-list"
  $('table.listTable tr, table.syllabus-list tr, table tr').each((_, tr) => {
    const link = $(tr).find('a[href*="detail"], a[href*="syllabus"]').first();
    if (!link.length) return;
    const href = link.attr('href');
    if (!href) return;
    courses.push({
      detailUrl: new URL(href, baseUrl).toString(),
      nameRaw: link.text().trim(),
    });
  });

  // ページネーション: 次ページのリンクを返す
  const nextPage = $('a.next, a[rel="next"], a:contains("次ページ"), a:contains("次へ")').attr('href');

  return {
    courses,
    nextPageUrl: nextPage ? new URL(nextPage, baseUrl).toString() : null,
  };
}

/**
 * CampusPlan科目詳細ページのHTMLから1科目分のデータを抽出。
 */
export function parseCourseDetailPage(html, { universityName, year, detailUrl }) {
  const $ = cheerio.load(html);

  const fields = {};
  // CampusPlanは <dl>/<dt>/<dd> 形式が多い
  $('dl dt, table th').each((i, el) => {
    const key = $(el).text().trim();
    const val = $(el).next('dd, td').text().trim();
    if (key && val) fields[key] = val;
  });
  // フォールバック: table th/td
  $('table tr').each((_, tr) => {
    const th = $(tr).find('th').first().text().trim();
    const td = $(tr).find('td').first().text().trim();
    if (th && td && !fields[th]) fields[th] = td;
  });

  const name = fields['授業科目名'] || fields['科目名'] || fields['講義題目'] || '';
  const instructor = fields['担当教員'] || fields['教員'] || '';
  const faculty = fields['対象学部'] || fields['学部'] || '';
  const dayPeriodRaw = fields['曜日・時限'] || fields['曜日時限'] || '';
  const room = fields['教室'] || '';
  const credits = parseInt(fields['単位数'] || '0') || 0;
  const semester = fields['学期'] || '';
  const description = fields['授業概要'] || fields['概要'] || '';
  const textbookRaw = fields['教科書'] || '';

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
    textbooks: parseTextbooks(textbookRaw),
    slotKey,
    lectureId,
    lectureIdWithInstructor,
    cmsType: 'campusplan',
    sourceUrl: detailUrl,
  };
}

function parseDayPeriod(raw) {
  if (!raw) return {};
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
  if (!raw || raw === 'なし') return [];
  const isbns = [...raw.matchAll(/978[-\s]?[0-9]{10}/g)].map((m) => m[0].replace(/[-\s]/g, ''));
  if (isbns.length > 0) return isbns.map((isbn) => ({ isbn, title: raw.slice(0, 100), author: '' }));
  return [{ title: raw.slice(0, 200), author: '', isbn: '' }];
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (raw.includes('春') || raw.includes('前期')) return 'spring';
  if (raw.includes('秋') || raw.includes('後期')) return 'fall';
  if (raw.includes('通年') || raw.includes('年間')) return 'full';
  return 'unknown';
}
