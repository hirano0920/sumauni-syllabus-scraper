/**
 * スマユニ シラバス スクレイパー エントリーポイント
 *
 * 使い方:
 *   node src/index.js --cms=livecampus
 *   node src/index.js --cms=campusplan
 *   node src/index.js --cms=tsukuba
 *   node src/index.js --university=早稲田大学
 *
 * 環境変数:
 *   FIREBASE_SA_KEY  ... Firebase サービスアカウントキー (JSON文字列)
 *   SCRAPE_YEAR      ... 対象年度 (デフォルト: 当年度)
 *   DRY_RUN          ... "1" にするとFirestoreに書かない
 */
import { createFetcher } from './lib/fetcher.js';
import { initFirestore, writeCourses, writeRoomIndex } from './lib/firestore.js';
import { parseCourseListPage as lcListParser, parseCourseDetailPage as lcDetailParser } from './universities/livecampus.js';
import { parseCourseListPage as cpListParser, parseCourseDetailPage as cpDetailParser } from './universities/campusplan.js';
import { scrapeAll as scrapeTsukuba } from './universities/tsukuba.js';
import { scrapeAll as scrapeWaseda } from './universities/waseda.js';
import { recon } from './lib/recon.js';
import universities from '../config/universities.json' assert { type: 'json' };
import pLimit from 'p-limit';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const YEAR = parseInt(process.env.SCRAPE_YEAR ?? new Date().getFullYear());
const DRY_RUN = process.env.DRY_RUN === '1';
const CMS_FILTER = args.cms?.toLowerCase();
const UNIV_FILTER = args.university;

async function main() {
  console.log(`== スマユニ シラバス スクレイパー ==`);
  console.log(`year=${YEAR}, cms=${CMS_FILTER ?? 'all'}, university=${UNIV_FILTER ?? 'all'}, dryRun=${DRY_RUN}`);

  // --- 偵察モード: --recon で対象大学の構造だけ吐き出す（Firestore書き込みなし） ---
  if (args.recon) {
    const all = [
      ...universities.livecampus, ...universities.campusplan,
      ...universities.gakuen, ...universities.custom,
    ];
    const targets = UNIV_FILTER ? all.filter(u => u.name === UNIV_FILTER) : all;
    if (targets.length === 0) {
      console.log(`[recon] 対象大学が見つかりません: ${UNIV_FILTER}`);
      return;
    }
    for (const u of targets) {
      await recon(u.name, u.syllabusBase);
    }
    return;
  }

  if (!DRY_RUN) initFirestore();

  const fetcher = createFetcher({ intervalMs: 1200 });
  const results = { success: 0, failed: 0, total: 0 };

  // --- 筑波 KdB ---
  if (!CMS_FILTER || CMS_FILTER === 'tsukuba') {
    if (!UNIV_FILTER || UNIV_FILTER === '筑波大学') {
      await runScraper('筑波大学', () => scrapeTsukuba(fetcher, YEAR), results);
    }
  }

  // --- 早稲田 (LiveCampus専用) ---
  if (!CMS_FILTER || CMS_FILTER === 'livecampus' || CMS_FILTER === 'waseda') {
    if (!UNIV_FILTER || UNIV_FILTER === '早稲田大学') {
      await runScraper('早稲田大学', () => scrapeWaseda(fetcher, YEAR), results);
    }
  }

  // --- LiveCampus (その他) ---
  if (!CMS_FILTER || CMS_FILTER === 'livecampus') {
    for (const univ of universities.livecampus) {
      if (univ.name === '早稲田大学') continue; // 上で処理済み
      if (UNIV_FILTER && univ.name !== UNIV_FILTER) continue;
      await runGenericScraper(univ, 'livecampus', fetcher, lcListParser, lcDetailParser, results);
    }
  }

  // --- CampusPlan ---
  if (!CMS_FILTER || CMS_FILTER === 'campusplan') {
    for (const univ of universities.campusplan) {
      if (UNIV_FILTER && univ.name !== UNIV_FILTER) continue;
      await runGenericScraper(univ, 'campusplan', fetcher, cpListParser, cpDetailParser, results);
    }
  }

  // --- 学園シリーズ (CampusPlanと類似構造) ---
  if (!CMS_FILTER || CMS_FILTER === 'gakuen') {
    for (const univ of universities.gakuen) {
      if (UNIV_FILTER && univ.name !== UNIV_FILTER) continue;
      // 学園シリーズはCampusPlanパーサーで代用可能なことが多い (要確認)
      await runGenericScraper(univ, 'gakuen', fetcher, cpListParser, cpDetailParser, results);
    }
  }

  // --- カスタム ---
  if (!CMS_FILTER || CMS_FILTER === 'custom') {
    for (const univ of universities.custom) {
      if (UNIV_FILTER && univ.name !== UNIV_FILTER) continue;
      console.log(`[skip] ${univ.name} — カスタムスクレイパー未実装 (scraper: ${univ.scraper})`);
      // TODO: 各大学のスクレイパーを個別実装後にここに追加
    }
  }

  console.log(`\n== 完了 ==`);
  console.log(`成功: ${results.success}校 / 失敗: ${results.failed}校 / 合計: ${results.total}科目`);
}

async function runScraper(universityName, scraperFn, results) {
  console.log(`\n[${universityName}] 開始`);
  try {
    const courses = await scraperFn();
    console.log(`[${universityName}] ${courses.length}科目取得`);
    if (!DRY_RUN && courses.length > 0) {
      await writeCourses(universityName, courses);
      await writeRoomIndex(universityName, courses);
    }
    results.success++;
    results.total += courses.length;
  } catch (e) {
    console.error(`[${universityName}] 失敗: ${e.message}`);
    results.failed++;
  }
}

async function runGenericScraper(univConfig, cmsType, fetcher, listParser, detailParser, results) {
  const { name, syllabusBase, year = YEAR } = univConfig;
  console.log(`\n[${name}] 開始 (${cmsType})`);

  try {
    // Step 1: 科目一覧ページから詳細URLを収集
    const detailUrls = await collectDetailUrls(fetcher, syllabusBase, listParser);
    console.log(`[${name}] 詳細URL ${detailUrls.length}件`);

    // Step 2: 詳細ページを順次取得・パース (並列4で処理)
    const limit = pLimit(4);
    const courses = [];
    const tasks = detailUrls.map(({ detailUrl }) =>
      limit(async () => {
        try {
          const html = await fetcher.fetchHtml(detailUrl);
          const course = detailParser(html, { universityName: name, year, detailUrl });
          if (course) courses.push(course);
        } catch (e) {
          // 個別失敗は警告のみ
          console.warn(`  [${name}] ${detailUrl} 取得失敗: ${e.message}`);
        }
      })
    );
    await Promise.all(tasks);

    console.log(`[${name}] ${courses.length}科目パース完了`);
    if (!DRY_RUN && courses.length > 0) {
      await writeCourses(name, courses);
      await writeRoomIndex(name, courses);
    }
    results.success++;
    results.total += courses.length;
  } catch (e) {
    console.error(`[${name}] 失敗: ${e.message}`);
    results.failed++;
  }
}

async function collectDetailUrls(fetcher, baseUrl, listParser) {
  const all = [];
  let currentUrl = baseUrl;
  let pageCount = 0;
  const MAX_PAGES = 200; // 無限ループ防止

  while (currentUrl && pageCount < MAX_PAGES) {
    const html = await fetcher.fetchHtml(currentUrl);
    const result = listParser(html, currentUrl);
    // listParser は { courses, nextPageUrl } or courses[] を返す
    const courses = Array.isArray(result) ? result : result.courses ?? [];
    const nextPageUrl = Array.isArray(result) ? null : result.nextPageUrl;

    all.push(...courses);
    currentUrl = nextPageUrl;
    pageCount++;
    if (courses.length === 0) break;
  }

  return all;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
