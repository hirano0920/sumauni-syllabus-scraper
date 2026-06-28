/**
 * 筑波大学 KdB — CSV/Excelダウンロード方式
 *
 * KdBは重いSPAでデータ行が動的描画されるため、HTMLパースは不安定。
 * 「科目一覧ダウンロード」(#btnListDownload)で全科目を構造化ファイルとして取得する。
 *
 * 列順(確認済み): 科目番号|科目名|授業方法|単位|年次|学期|曜時限|担当|概要|備考|科目等履修生
 */
import * as XLSX from 'xlsx';
import { readFile } from 'fs/promises';
import { withPage } from '../lib/browser.js';
import { buildLectureId, buildSlotKey, normalizeSubject, normalizeInstructor } from '../lib/lecture_id.js';

const UNIVERSITY_NAME = '筑波大学';
const TOP_URL = 'https://kdb.tsukuba.ac.jp/';

export async function scrapeAll(fetcher, year = 2025) {
  console.log(`[tsukuba] 開始 year=${year}`);

  return withPage(async (page) => {
    await page.goto(TOP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // 検索を実行して結果を母集合にする（ダウンロードは検索結果対象のことが多い）
    await page.locator('#btnSearch').click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // ダウンロードを待ち受けて「科目一覧ダウンロード」をクリック
    let filePath = null;
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        page.locator('#btnListDownload').click(),
      ]);
      filePath = await download.path();
      const suggested = download.suggestedFilename();
      console.log(`[tsukuba] ダウンロード成功: ${suggested}`);
    } catch (e) {
      console.warn(`[tsukuba] ダウンロード失敗: ${e.message}`);
      return [];
    }

    if (!filePath) return [];

    // ファイルをパース（CSV/Excel自動判定）
    const rows = await parseFile(filePath);
    console.log(`[tsukuba] ファイル行数: ${rows.length}`);
    // 実データ行をダンプして列構造を確定する（各列を index:値 形式で）
    for (let i = 0; i < Math.min(4, rows.length); i++) {
      const labeled = (rows[i] || []).map((v, idx) => `[${idx}]${`${v}`.slice(0, 18)}`).join(' | ');
      console.log(`[tsukuba] row${i}: ${labeled}`);
    }

    const courses = mapRows(rows, year);
    console.log(`[tsukuba] 有効科目: ${courses.length}`);
    return courses;
  });
}

async function parseFile(filePath) {
  // xlsxはCSVもExcelも読める
  const buf = await readFile(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', codepage: 932 }); // Shift-JIS対応
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

function mapRows(rows, year) {
  const courses = [];
  // 1行目はヘッダーなのでスキップ
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length < 8) continue;

    // 列順: 0科目番号 1科目名 2授業方法 3単位 4年次 5学期 6曜時限 7担当
    const name = `${r[1] ?? ''}`.trim();
    const credits = parseFloat(`${r[3] ?? ''}`) || 0;
    const semRaw = `${r[5] ?? ''}`.trim();
    const dayPeriodRaw = `${r[6] ?? ''}`.trim();
    const instructor = `${r[7] ?? ''}`.trim();

    if (!name || name.length < 2) continue;

    const { dayOfWeek, period } = parseDayPeriod(dayPeriodRaw);
    if (!dayOfWeek || !period) continue;

    const slotKey = buildSlotKey({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
    const lectureId = buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name });
    const lectureIdWithInstructor = instructor
      ? buildLectureId({ universityName: UNIVERSITY_NAME, dayJa: dayOfWeek, period, subject: name, instructor })
      : lectureId;

    courses.push({
      universityName: UNIVERSITY_NAME, year,
      semester: normalizeSemester(semRaw),
      name, nameNorm: normalizeSubject(name),
      dayOfWeek, period, periodEnd: period,
      room: '', instructor, instructorNorm: normalizeInstructor(instructor),
      faculty: '', credits, description: '', textbooks: [],
      slotKey, lectureId, lectureIdWithInstructor,
      cmsType: 'kdb_tsukuba', sourceUrl: TOP_URL,
    });
  }
  return courses;
}

function parseDayPeriod(raw) {
  // "春AB 月1,2" や "秋C 火3" など。曜日と最初の時限を取る
  const dayMap = { '月':'月曜日','火':'火曜日','水':'水曜日','木':'木曜日','金':'金曜日','土':'土曜日','日':'日曜日' };
  const m = raw.match(/([月火水木金土日])\s*([0-9０-９]+)/);
  if (!m) return {};
  const period = parseInt(m[2].replace(/[０-９]/g, d => '０１２３４５６７８９'.indexOf(d)));
  return { dayOfWeek: dayMap[m[1]] ?? null, period: period || null };
}

function normalizeSemester(raw) {
  if (!raw) return 'unknown';
  if (raw.includes('春')) return 'spring';
  if (raw.includes('秋')) return 'fall';
  return 'unknown';
}
