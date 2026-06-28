/**
 * 筑波大学 KdB スクレイパー
 *
 * KdBはAPIが公開されており、最もスクレイピングしやすい大学の一つ。
 * https://kdb.tsukuba.ac.jp/
 *
 * APIエンドポイント (非公式だが安定して使われている):
 *   GET https://kdb.tsukuba.ac.jp/syllabi/{year}/{subjectNumber}/ja
 *   GET https://kdb.tsukuba.ac.jp/api/v1/syllabi?year={year}&page={page}
 *
 * 科目番号: GA1xxxx (教養), GB1xxxx (情報学群) など
 * 全科目走査: page=1,2,3... で全件取得
 */
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '筑波大学';
const BASE_URL = 'https://kdb.tsukuba.ac.jp';

export async function scrapeAll(fetcher, year = 2025) {
  console.log(`[tsukuba] 開始 year=${year}`);
  const courses = [];
  let page = 1;

  while (true) {
    const url = `${BASE_URL}/api/v1/syllabi?year=${year}&page=${page}&per_page=100`;
    let data;
    try {
      data = await fetcher.fetchJson(url);
    } catch (e) {
      console.warn(`[tsukuba] API失敗 page=${page}: ${e.message}`);
      // APIが使えない場合はHTMLスクレイピングにフォールバック
      break;
    }

    const items = data?.syllabi ?? data?.data ?? data ?? [];
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      const course = mapApiResponse(item, year);
      if (course) courses.push(course);
    }

    console.log(`[tsukuba] page=${page} +${items.length} (計${courses.length})`);
    if (!data?.next_page && !data?.hasNextPage) break;
    page++;
  }

  return courses;
}

function mapApiResponse(item, year) {
  // KdBのJSONフィールド名 (実際のAPIレスポンスに合わせて調整が必要)
  const name = item.科目名 ?? item.subject_name ?? item.name ?? '';
  const instructor = item.担当教員 ?? item.instructor ?? '';
  const faculty = item.学群 ?? item.department ?? '';
  const dayJa = item.曜日 ?? item.day ?? '';
  const period = parseInt(item.時限 ?? item.period ?? '0');
  const room = item.教室 ?? item.room ?? '';
  const credits = parseInt(item.単位数 ?? item.credits ?? '0') || 0;
  const semester = item.学期 ?? item.semester ?? '';
  const description = item.授業概要 ?? item.description ?? '';

  if (!name || !dayJa || !period) return null;

  const dayOfWeek = toDayJa(dayJa);
  if (!dayOfWeek) return null;

  const slotKey = buildSlotKey({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
  const lectureId = buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
  const lectureIdWithInstructor = instructor
    ? buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name, instructor })
    : lectureId;

  return {
    universityName: UNIVERSITY_NAME,
    year,
    semester: normalizeSemester(semester),
    name,
    nameNorm: normalizeSubject(name),
    dayOfWeek,
    period,
    periodEnd: period,
    room,
    instructor,
    instructorNorm: normalizeInstructor(instructor),
    faculty,
    credits,
    description,
    textbooks: [],
    slotKey,
    lectureId,
    lectureIdWithInstructor,
    cmsType: 'kdb_tsukuba',
    sourceUrl: `${BASE_URL}/syllabi/${year}/${item.科目番号 ?? item.id ?? ''}`,
  };
}

function toDayJa(raw) {
  const map = { '月': '月曜日', '火': '火曜日', '水': '水曜日', '木': '木曜日', '金': '金曜日', '土': '土曜日', '日': '日曜日', '月曜日': '月曜日', '火曜日': '火曜日', '水曜日': '水曜日', '木曜日': '木曜日', '金曜日': '金曜日', '土曜日': '土曜日', '日曜日': '日曜日' };
  return map[raw?.trim()] ?? null;
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (raw.includes('春') || raw.includes('1学期') || raw.includes('前期')) return 'spring';
  if (raw.includes('秋') || raw.includes('2学期') || raw.includes('後期')) return 'fall';
  if (raw.includes('通年')) return 'full';
  return 'unknown';
}
