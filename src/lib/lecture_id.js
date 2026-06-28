/**
 * LectureIdの正規化ロジック — lib/utils/lecture_id.dart と完全に同期。
 * Firestoreの`public_course_ratings`キーと一致させるために必須。
 */

const DAY_MAP = {
  '月曜日': 'Mon', '月': 'Mon',
  '火曜日': 'Tue', '火': 'Tue',
  '水曜日': 'Wed', '水': 'Wed',
  '木曜日': 'Thu', '木': 'Thu',
  '金曜日': 'Fri', '金': 'Fri',
  '土曜日': 'Sat', '土': 'Sat',
  '日曜日': 'Sun', '日': 'Sun',
};

function dayKey(dayJa) {
  return DAY_MAP[dayJa?.trim()] ?? '';
}

function sanitizeUniv(s) {
  let t = (s ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\//g, '／').replace(/#/g, '＃').replace(/\?/g, '？');
  if (!t) t = '大学未設定';
  if (t.length > 28) t = t.slice(0, 28).trim();
  return t;
}

function sanitizeSubject(s) {
  let t = (s ?? '').replace(/[\s　]+/g, '').trim();
  t = t.replace(/\//g, '／').replace(/#/g, '＃').replace(/\?/g, '？');
  if (!t) t = 'Unknown';
  if (t.length > 64) t = t.slice(0, 64).trim();
  return t;
}

function subjectStemForAggregation(sanitized) {
  let t = sanitized.trim();
  if (!t) return t;
  t = t.replace(/[ 　]*[（(][０-９0-9]+[)）][ 　]*$/, '');
  for (let g = 0; g < 6; g++) {
    const before = t;
    t = t.replace(/[ 　]*[ⅠＩIⅰi]$/, '');
    t = t.replace(/([぀-ゟ゠-ヿ一-鿿ｦ-ﾟ])I$/, '$1');
    t = t.replace(/([぀-ゟ゠-ヿ一-鿿ｦ-ﾟ])i$/, '$1');
    t = t.replace(/([぀-ゟ゠-ヿ一-鿿ｦ-ﾟ])Ⅰ$/, '$1');
    t = t.replace(/II$/, '').replace(/III$/, '');
    t = t.replace(/[ 　]*[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]$/, '');
    t = t.replace(/[ 　]*[0-9０-９]+$/, '');
    t = t.replace(/\s+/g, ' ').trim();
    if (t === before) break;
  }
  return t || sanitized;
}

export function normalizeSubject(raw) {
  return subjectStemForAggregation(sanitizeSubject(raw));
}

export function normalizeInstructor(raw) {
  let t = (raw ?? '').replace(/[\s　]+/g, '').trim();
  if (!t) return '';
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/(名誉)?(特任|客員|非常勤|嘱託|学外)?(准|副)?(教授|講師|助教|教諭|教員|先生)+$/, '');
    t = t.replace(/(氏|様)$/, '');
    if (t === before) break;
  }
  t = t.replace(/\//g, '／').replace(/#/g, '＃').replace(/\?/g, '？');
  if (!t) return '';
  if (t.length > 32) t = t.slice(0, 32);
  return t;
}

export function buildLectureId({ universityName, dayJa, period, subject, instructor }) {
  const u = sanitizeUniv(universityName);
  const day = dayKey(dayJa);
  if (!day) return '';
  const p = Math.min(Math.max(parseInt(period) || 1, 1), 9);
  const s = normalizeSubject(subject);
  const ins = normalizeInstructor(instructor ?? '');
  if (!ins) return `${u}-${day}-${p}-${s}`;
  return `${u}-${day}-${p}-${s}-${ins}`;
}

export function buildSlotKey({ universityName, dayJa, period, subject }) {
  const u = sanitizeUniv(universityName);
  const day = dayKey(dayJa);
  if (!day) return '';
  const p = Math.min(Math.max(parseInt(period) || 1, 1), 9);
  const s = normalizeSubject(subject);
  return `${u}-${day}-${p}-${s}`;
}
