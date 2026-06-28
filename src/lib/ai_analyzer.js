/**
 * AI自動解析: Claude APIにHTMLを渡してシラバスサイトの構造を自動抽出。
 * セレクタの手書きが不要になる。
 *
 * 1大学あたり1回のAPI呼び出し（$0.001以下）でセレクタを確定し、
 * 以降は確定したセレクタで高速スクレイピングする。
 */
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STRUCTURE_PROMPT = `
あなたは大学シラバスサイトのHTML解析の専門家です。
以下のHTMLから、シラバス一覧を取得するために必要な情報をJSON形式で返してください。

返すべきJSON:
{
  "tableSelector": "結果テーブルのCSSセレクタ (例: table.result__table)",
  "dataRowFilter": "データ行のフィルタ条件 (例: tr:has(td))",
  "columns": {
    "name": "科目名の列インデックス(0始まり)",
    "instructor": "担当教員の列インデックス",
    "dayPeriod": "曜日時限の列インデックス",
    "room": "教室の列インデックス (-1=なし)",
    "credits": "単位数の列インデックス (-1=なし)",
    "semester": "学期の列インデックス (-1=なし)"
  },
  "form": {
    "action": "フォームのaction URL",
    "yearSelect": "年度セレクトのname属性",
    "facultySelect": "学部セレクトのname属性 (なければnull)",
    "searchButton": "検索ボタンのセレクタ"
  },
  "pagination": {
    "nextSelector": "次ページへのリンクのセレクタ (なければnull)"
  },
  "notes": "特記事項（全角数字、曜日の表記形式など）"
}

JSONのみ返してください。説明不要。
`;

/**
 * @param {string} universityName
 * @param {string} html - シラバス結果ページのHTML（先頭15000文字で十分）
 * @returns {Promise<object>} - 解析結果JSON
 */
export async function analyzeStructure(universityName, html) {
  const truncated = html.slice(0, 15000);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `大学名: ${universityName}\n\nHTML:\n${truncated}\n\n${STRUCTURE_PROMPT}`,
    }],
  });

  const text = message.content[0].text.trim();
  // JSON部分だけ抽出
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`JSON解析失敗: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

/**
 * 解析済み構造を使って1ページ分のコースを抽出。
 */
export function extractCourses($, structure, universityName, faculty, year) {
  const { tableSelector, columns } = structure;
  const courses = [];

  $(`${tableSelector} tr`).each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length === 0) return;

    const get = (idx) => idx >= 0 && idx < cells.length
      ? $(cells[idx]).text().trim().replace(/\s+/g, ' ')
      : '';

    const name = get(columns.name).replace(/^[○◎△×＊※]\s*/, '');
    const instructor = get(columns.instructor);
    const dayPeriodRaw = get(columns.dayPeriod);
    const room = columns.room >= 0 ? get(columns.room) : '';
    const creditsRaw = columns.credits >= 0 ? get(columns.credits) : '';
    const credits = parseInt(creditsRaw.replace(/[^0-9]/g, '')) || 0;

    if (!name || name.length < 2) return;

    courses.push({ name, instructor, dayPeriodRaw, room, credits, faculty, universityName, year });
  });

  return courses;
}
