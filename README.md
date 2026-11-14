# 高嶺神社 公式サイト

https://www.takaminejinja.jp/ を WordPress から静的サイト（[Astro](https://astro.build/)）に移行し、Cloudflare Pages で公開するためのリポジトリです。

## 構成

| 場所 | 内容 |
|---|---|
| `src/pages/` | 各ページ（トップ、高嶺神社について、お知らせ、祭典・行事、ブログ など） |
| `src/data/*.json` | お知らせ・祭典行事・ブログ・固定ページの本文（WordPress から取り込んだもの） |
| `src/data/site.ts` | メニュー、住所、SNS などサイト共通の設定 |
| `src/styles/global.css` | デザイン |
| `public/wp-content/uploads/` | 画像・動画（旧サイトと同じURLのまま） |
| `functions/api/contact.ts` | お問い合わせフォームの送信処理（Cloudflare Pages Functions） |
| `public/_redirects` | 旧サイトのURLからの転送設定 |
| `scripts/import_wp.py` | WordPress からコンテンツを取り込むスクリプト |

URL は旧サイトと同じです（`/about/`、`/news/20260311/`、`/kuroboshi_unki/` など）。

## ローカルで確認する

```sh
npm install
npm run dev        # http://localhost:4321 で確認（フォーム送信以外）
npm run build      # dist/ に書き出し
npm run preview    # フォームの処理も含めて確認（Cloudflare 環境の再現）
```

Node.js 22 以上が必要です。

## お知らせ・記事の更新

`src/data/news.json`（お知らせ）、`src/data/events.json`（祭典・行事）、`src/data/blog.json`（ブログ）を編集します。
**配列の先頭が一番新しい記事**です。画像は `public/` 以下に置き、`/` から始まるパスで指定します。

お知らせの例:

```json
{
  "slug": "20261101",
  "title": "七五三詣の予約を受け付けています",
  "date": "2026.11.01",
  "datetime": "2026-11-01",
  "img": "/wp-content/uploads/2026/11/753.jpg",
  "thumb": "/wp-content/uploads/2026/11/753.jpg",
  "description": "一覧や検索結果に表示される説明文",
  "html": "<p>本文（HTML）</p>"
}
```

祭典・行事（`events.json`）は、`schedule` に毎年の開催日を書くと、**次に行うものから順**に自動で並びます（日本時間の今日を基準に、ブラウザでも並べ直します）。

```json
"schedule": { "month": 4, "day": 12 }                   // 4月12日
"schedule": { "month": 1, "day": 10, "endDay": 15 }     // 1月10日〜15日（15日を過ぎるまで先頭に残る）
"schedule": { "month": 10, "nth": 2, "weekday": 0 }     // 10月の第2日曜日（weekday: 0=日〜6=土）
```

画面に出る日付の文言は `dateText` です。開催日が変わったら `dateText` と `schedule` の両方を直してください。

GitHub にプッシュすると、Cloudflare Pages が自動で公開します（1〜2分）。

## Cloudflare Pages での公開手順

1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) →「Workers & Pages」→「作成」→「Pages」→「Git に接続」
2. このリポジトリを選び、以下を設定
   - フレームワーク プリセット: `Astro`
   - ビルドコマンド: `npm run build`
   - ビルド出力ディレクトリ: `dist`
3. 「保存してデプロイ」。`https://<プロジェクト名>.pages.dev` で確認できます

## お問い合わせフォームの設定

フォームは Cloudflare Turnstile（スパム対策）と [Resend](https://resend.com/)（メール送信）を使います。

1. **Turnstile**: Cloudflare ダッシュボード →「Turnstile」→ ウィジェットを追加
   - ホスト名に `www.takaminejinja.jp` と `<プロジェクト名>.pages.dev` を登録
   - サイトキーとシークレットキーを控える
2. **Resend**: アカウントを作成し、ドメイン `takaminejinja.jp` を追加
   - 表示される DNS レコード（TXT / MX、`send.takaminejinja.jp` などのサブドメイン用）をさくらのドメイン管理画面に追加
   - ※ ルートドメインの MX レコード（今のメール）は変更しません
   - API キーを作成して控える
3. Cloudflare Pages →「設定」→「変数とシークレット」に以下を登録（本番・プレビュー両方）

   | 名前 | 種類 | 値 |
   |---|---|---|
   | `PUBLIC_TURNSTILE_SITE_KEY` | テキスト | Turnstile のサイトキー |
   | `TURNSTILE_SECRET_KEY` | シークレット | Turnstile のシークレットキー |
   | `RESEND_API_KEY` | シークレット | Resend の API キー |
   | `MAIL_TO` | テキスト | お問い合わせを受け取るアドレス |
   | `MAIL_FROM` | テキスト | `高嶺神社 <noreply@takaminejinja.jp>` |

4. 再デプロイ後、フォームから試しに送信して、社務所と自分の両方にメールが届くことを確認

## 独自ドメインの切り替え（さくらインターネット）

ネームサーバーはさくらのまま、`www` のレコードだけを切り替えます。メール（MX レコード）には触りません。

1. Cloudflare Pages →「カスタムドメイン」→ `www.takaminejinja.jp` を追加
2. さくらのドメインコントロールパネル → `takaminejinja.jp` のゾーン編集
   - `www` の既存レコード（A / CNAME）を削除し、`www` → `<プロジェクト名>.pages.dev.` の **CNAME** を追加
3. 反映後（数分〜数時間）、Cloudflare 側で「有効」になり、SSL 証明書も自動で発行されます
4. `www` なしの `takaminejinja.jp` は、引き続き さくらのサーバーで `https://www.takaminejinja.jp/` へ転送します
   （WordPress を停止する場合は、さくらのサーバーの `.htaccess` に転送設定を書きます）

元に戻す場合は、`www` のレコードを元の値に戻すだけです。
**メールも同じさくらのサーバーで動いているため、サーバー契約は解約しないでください。**

## WordPress からの再取り込み

```sh
pip install beautifulsoup4 lxml
python3 scripts/import_wp.py
```

公開中の WordPress から本文と画像を取り込み直します（`src/data/*.json` は上書きされます）。

## ご祈祷の予約フォーム（/reservation/）

送信内容は Airtable の「参拝者管理」base の予約の表に、「予約ステータス = 仮予約」「受付経路 = Webフォーム」で書き込みます。
ご家族など一緒に受ける方（20名まで）は、1人1行で書き込み、全員の行に同じ「予約番号」（例 `W261114-7KQ2`）を入れます。
最初の方の行だけ「代表者」にチェックを入れ、「同時に受ける方」に全員の名前と祈願内容の一覧を入れます（受付メール・確定メールは代表者の行から送る）。
同じ日時の行は何人いても1組として数えます。
お一人で複数のご祈願を選んだ場合は、1行の「御祈祷内容」（複数選択）にまとめて入れます。
参拝者へのメールは予約につき1通、代表者の行から送ります。
予約全体の初穂料を計算し、全員の行の「予約の初穂料合計」（数値）と「初穂料の内訳」（文章）に入れます（決まりは `src/lib/reservation.ts` の `feeSummary`）。
クレジットカードのお支払いの案内は、予約につき1通、この合計で送ります。
代表者の行の「予約の詳細」には、今までの受付メールと同じ並びで、日時、全員の名前・生年月日（和暦つき）・ご祈願と祈願内容ごとの欄（父母の名前、車など）、連絡先、納め方、初穂料、連絡事項をまとめて入れます（参拝者へのメールにも神社へのメールにも、これを差し込む）。神社が手で入れる「初穂料」の項目には触りません。
受付メール・確定メールは、Airtable の Automations が送ります。

- 30分に1組（9:00〜16:30）。キャンセル以外の予約（電話予約・郵送以外）がある時刻は選べない
- 翌日から32日後まで。翌日分は前日20時まで（`src/lib/reservation.ts`）
- 「受付停止日」の表に行を足すと、その日（または時間帯）が選べなくなる
  - 項目：日付（日付）、開始時刻・終了時刻（文字。例 `10:00`。空なら終日）、理由
  - 開始時刻〜終了時刻の前まで止まる（10:00〜12:00 なら 10:00〜11:30 の回）

郵便番号を入れると住所が入る仕組みは、日本郵便のデータを `public/zip/` に置いて使っています（外部のサービスは使いません）。
年に1〜2回、日本郵便の「住所の郵便番号（1レコード1行、UTF-8形式）」の全国一括（`utf_ken_all.zip`）を取り直して作り直します。

```sh
python3 scripts/build_zipcode.py utf_ken_all.csv
```

Cloudflare Pages の「設定 → 変数とシークレット」に、お問い合わせフォームの値に加えて登録する値：

| 名前 | 種類 | 値 |
|---|---|---|
| `AIRTABLE_TOKEN` | シークレット | 個人用アクセストークン。権限は `data.records:read` と `data.records:write`、対象はこの base だけ |
| `AIRTABLE_BASE_ID` | テキスト | `appoYCG4NVj42pQ4f` |
| `AIRTABLE_TABLE` | テキスト | `tbliY7bHIC8bt3ZvW`（予約受付） |
| `AIRTABLE_CLOSURE_TABLE` | テキスト | `受付停止日` |
