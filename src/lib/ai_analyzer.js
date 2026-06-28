/**
 * AI自動解析: DeepSeek APIにHTMLを渡してシラバスサイトの構造を自動抽出。
 * OpenAI互換APIなのでbase_urlを変えるだけで動く。
 *
 * DeepSeek-V3: $0.07/MTok(input) — $9.92で約140M tokens = 約9000大学分
 */
import OpenAI from 'openai';

// Secret名は DEEPSEEK_KEY / DEEPSEEK_API_KEY どちらでも可
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

// モデルは環境変数で上書き可能。デフォルトは最新版に追従する deepseek-chat
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

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
 * フォーム解析: ページの操作要素(select/button)の要約から
 * 「どれが年度・学部・検索ボタンか」をAIに判断させる。
 * @param {string} universityName
 * @param {object} elements - { selects: [{name,id,sampleOptions}], buttons: [{tag,id,value,text,selector}] }
 */
export async function analyzeForm(universityName, elements) {
  const prompt = `
大学名: ${universityName}
以下は大学シラバス検索ページの操作要素です。

SELECT要素:
${JSON.stringify(elements.selects, null, 1)}

ボタン要素:
${JSON.stringify(elements.buttons, null, 1)}

この検索フォームで「全科目を検索する」ために必要な情報をJSONで返してください:
{
  "yearSelectName": "年度を選ぶselectのname (なければnull)",
  "facultySelectName": "学部/開設母体を選ぶselectのname (なければnull)。学部単位で回せるものを優先",
  "searchButtonSelector": "検索を実行するボタンのCSSセレクタ (例: input[value=\\"検索\\"])"
}
JSONのみ。`;

  const res = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.choices[0].message.content.trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`form解析失敗: ${text.slice(0, 150)}`);
  return JSON.parse(m[0]);
}

/**
 * SPA傍受JSONの1要素を見せて、科目フィールドのパスをAIに判定させる。
 * @param {object} sampleItem - 科目1件のJSONオブジェクト
 * @returns {Promise<{name,instructor,day,period}>} ドット区切りパス
 */
export async function analyzeJson(universityName, sampleItem) {
  const prompt = `
大学名: ${universityName}
以下は大学シラバスAPIが返す科目1件のJSONです:
${JSON.stringify(sampleItem, null, 1).slice(0, 2000)}

このJSONから各情報のキー(ドット区切りパス)をJSONで返してください:
{
  "name": "科目名のパス (例: subjectName)",
  "instructor": "担当教員のパス (なければnull)",
  "day": "曜日のパス (例: dayOfWeek)",
  "period": "時限のパス (曜日と同じフィールドなら同じ値、なければnull)"
}
JSONのみ。`;
  const res = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 256,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.choices[0].message.content.trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`json解析失敗: ${text.slice(0, 150)}`);
  return JSON.parse(m[0]);
}

/**
 * @param {string} universityName
 * @param {string} html - シラバス結果ページのHTML（先頭15000文字で十分）
 * @returns {Promise<object>} - 解析結果JSON
 */
export async function analyzeStructure(universityName, html) {
  const truncated = html.slice(0, 15000);

  const message = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: `大学名: ${universityName}\n\nHTML:\n${truncated}\n\n${STRUCTURE_PROMPT}`,
    }],
  });

  const text = message.choices[0].message.content.trim();
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
