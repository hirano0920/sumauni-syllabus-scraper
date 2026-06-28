/**
 * 筑波大学 KdB スクレイパー (HTMLスクレイピング版)
 * API (403) → HTML直接スクレイピングに切り替え
 */
import * as cheerio from 'cheerio';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '筑波大学';
const BASE_URL = 'https://kdb.tsukuba.ac.jp';

const SEMESTERS = [
  { code: '1A', label: '春A' }, { code: '1B', label: '春B' }, { code: '1C', label: '春C' },
  { code: '2A', label: '秋A' }, { code: '2B', label: '秋B' }, { code: '2C', label: '秋C' },
];

export async function scrapeAll(fetcher, year = 2025) {
  console.log(`[tsukuba] HTMLスクレイピング開始 year=${year}`);
  const courses = [];

  for (const sem of SEMESTERS) {
    try {
      const semCourses = await scrapeSemester(fetcher, year, sem);
      courses.push(...semCourses);
      console.log(`[tsukuba] ${sem.label}: ${semCourses.length}科目`);
    } catch (e) {
      console.warn(`[tsukuba] ${sem.label} 失敗: ${e.message}`);
    }
  }

  console.log(`[tsukuba] 合計 ${courses.length}科目`);
  return courses;
}

async function scrapeSemester(fetcher, year, sem) {
  const courses = [];
  let page = 1;

  while (page <= 50) {
    const url = `${BASE_URL}/syllabi?year=${year}&semester=${sem.code}&page=${page}&size=100`;
    const html = await fetcher.fetchHtml(url);
    const $ = cheerio.load(html);

    // KdBのテーブル行を取得（実際のセレクタは確認後調整）
    const rows = $('table tbody tr').filter((_, tr) => $(tr).find('td').length >= 4);
    if (rows.length === 0) break;

    let added = 0;
    rows.each((_, tr) => {
      const course = parseRow($, tr, year, sem.label);
      if (course) { courses.push(course); added++; }
    });

    if (added === 0) break;
    page++;
  }

  return courses;
}

function parseRow($, tr, year, semLabel) {
  const cells = $(tr).find('td');
  // KdB列順: 科目番号|科目名|単位|標準年次|実施学期|曜時限|教室|担当教員
  const name = $(cells[1]).text().trim();
  const dayPeriodRaw = $(cells[5]).text().trim();
  const room = $(cells[6]).text().trim() || '';
  const instructor = $(cells[7]).text().trim() || '';
  const credits = parseInt($(cells[2]).text().trim()) || 0;

  if (!name || !dayPeriodRaw) return null;

  const { dayOfWeek, period } = parseDayPeriod(dayPeriodRaw);
  if (!dayOfWeek || !period) return null;

  const slotKey = buildSlotKey({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
  const lectureId = buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
  const lectureIdWithInstructor = instructor
    ? buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name, instructor })
    : lectureId;

  return {
    universityName: UNIVERSITY_NAME, year,
    semester: semLabel.includes('春') ? 'spring' : 'fall',
    name, nameNorm: normalizeSubject(name),
    dayOfWeek, period, periodEnd: period,
    room, instructor, instructorNorm: normalizeInstructor(instructor),
    faculty: '', credits, description: '', textbooks: [],
    slotKey, lectureId, lectureIdWithInstructor,
    cmsType: 'kdb_tsukuba',
    sourceUrl: `${BASE_URL}/syllabi/${year}`,
  };
}

function parseDayPeriod(raw) {
  const dayMap = { '月':'月曜日','火':'火曜日','水':'水曜日','木':'木曜日','金':'金曜日','土':'土曜日','日':'日曜日' };
  const m = raw.match(/([月火水木金土日])/);
  const p = raw.match(/(\d)/);
  if (!m || !p) return {};
  return { dayOfWeek: dayMap[m[1]] ?? null, period: parseInt(p[1]) };
}
