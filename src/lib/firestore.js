/**
 * Firestoreバッチ書き込み。
 * 書き込み先: syllabi/{universityName}/courses/{courseDocId}
 */
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

let db = null;

export function initFirestore() {
  if (getApps().length === 0) {
    const sa = process.env.FIREBASE_SA_KEY;
    if (!sa) throw new Error('FIREBASE_SA_KEY env var is required');
    const credential = cert(JSON.parse(sa));
    initializeApp({ credential });
  }
  db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
}

/**
 * courses: CourseRecord[]
 * CourseRecord: {
 *   universityName, year, semester, name, dayOfWeek, period, periodEnd,
 *   room, instructor, faculty, credits, description,
 *   textbooks: [{title, author, isbn}],
 *   slotKey, lectureId, lectureIdWithInstructor, cmsType
 * }
 */
export async function writeCourses(universityName, courses) {
  if (!db) throw new Error('Call initFirestore() first');
  const col = db.collection('syllabi').doc(universityName).collection('courses');

  const BATCH_SIZE = 400;
  let written = 0;

  for (let i = 0; i < courses.length; i += BATCH_SIZE) {
    const chunk = courses.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const c of chunk) {
      const docId = `${c.year}_${c.slotKey.replace(/[/]/g, '_')}`;
      batch.set(col.doc(docId), {
        ...c,
        scrapedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
    written += chunk.length;
    console.log(`  [firestore] wrote ${written}/${courses.length}`);
  }
}

/**
 * 空き教室検索用インデックスも書く。
 * rooms/{universityName}/slots/{day}_{period} => { rooms: string[] }
 */
export async function writeRoomIndex(universityName, courses) {
  if (!db) throw new Error('Call initFirestore() first');
  const col = db.collection('room_index').doc(universityName).collection('slots');

  // group by day+period
  const map = new Map();
  for (const c of courses) {
    if (!c.room || !c.dayOfWeek || !c.period) continue;
    const key = `${c.dayOfWeek}_${c.period}`;
    if (!map.has(key)) map.set(key, new Set());
    c.room.split(/[・,、]+/).map((r) => r.trim()).filter(Boolean).forEach((r) => map.get(key).add(r));
  }

  const BATCH_SIZE = 400;
  const entries = [...map.entries()];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const [key, rooms] of entries.slice(i, i + BATCH_SIZE)) {
      batch.set(col.doc(key), { rooms: [...rooms].sort(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    await batch.commit();
  }
}
