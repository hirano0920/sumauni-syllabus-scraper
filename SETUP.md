# シラバス スクレイパー セットアップ

## 必要な準備（あなたにやってもらうこと）

### 1. GitHubリポジトリをPublicにする
Student Developer Packを使っていても、**Publicリポジトリなら Actions分数が無制限**。
Private のままなら月3000分（Proプラン）。

Settings → General → Danger Zone → Change repository visibility → Public

### 2. Firebase サービスアカウントキーの作成
```
Firebase Console
→ プロジェクト設定 → サービスアカウント
→ 「新しい秘密鍵を生成」→ JSONダウンロード
```

### 3. GitHub Secrets に登録
```
GitHub リポジトリ
→ Settings → Secrets and variables → Actions → New repository secret

Name:  FIREBASE_SA_KEY
Value: (ダウンロードしたJSONの中身をまるごとペースト)
```

### 4. Firestore ルール・インデックスをデプロイ
```bash
firebase deploy --only firestore:rules,firestore:indexes
```

### 5. ローカルでテスト実行（DRY RUN）
```bash
cd scraper
npm install
DRY_RUN=1 node src/index.js --cms=tsukuba
```

---

## 実行方法

### GitHub Actions から手動実行
GitHub → Actions → "Syllabus Scraper" → "Run workflow"

パラメータ:
- `cms`: `livecampus` / `campusplan` / `gakuen` / `tsukuba` / `all`
- `university`: 特定大学のみ（例: `早稲田大学`）
- `dry_run`: チェックするとFirestoreに書かない

### 自動実行
毎週日曜 2:00 JST に全大学を自動実行。

---

## 実装状況

| CMS | 状態 | 対象校数 |
|-----|------|---------|
| KdB (筑波) | ✅ API対応済み | 1校 |
| LiveCampus | 🔧 パーサー実装済み・URL確認要 | 13校 |
| CampusPlan | 🔧 パーサー実装済み・URL確認要 | 8校 |
| 学園シリーズ | 🔧 パーサー実装済み・URL確認要 | 5校 |
| カスタム (東大等) | ⏳ 個別実装待ち | 16校 |

## 次のステップ（Claude Codeと一緒にやる）

1. **早稲田大学のLiveCampus URLを確認**してスクレイパーを動かす
   → `DRY_RUN=1 node src/index.js --university=早稲田大学`
   → 取得できたらHTMLを見てパーサーを調整

2. **立命館大学でCampusPlanを確認**（関関同立4校が一気にカバーできる）

3. **東大 UTAS** は独自API的なURL構造あり、要解析

4. Flutter側で`SyllabusContextService.buildTimetableContext()`を
   時間割インポートのAIプロンプトに追加
