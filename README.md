# 放送メモ / TV Notifier

好きな番組の**次の放送・次のエピソード**を、再放送も含めてiPhoneへ通知する個人用PWAです。
**GitHub Pages + Cloudflare Workers Free / D1 Free + Web Push** を使用します。独自ドメイン・有料Apple Developer登録は不要です。

## 対応範囲

| 番組 | 自動取得 |
| --- | --- |
| NHK『弾丸!空港トンボがえりツアー』『地球ドラマチック』『世界ふれあい街歩き』『鉄オタ選手権』 | NHK公式API v3用アダプターを実装。APIキーを設定して実データとの照合が必要 |
| TBS『世界遺産』・日テレ『アナザースカイ』 | **未対応**。公式サイトへのリンクのみ。ONにしても通知されません |
| 追加登録したNHK番組 | 番組名の部分一致。表記や番組表掲載状況によって見つからないことがあります |

- 地域は神奈川（横浜・`140`）に固定。地上波が初期設定、BS・BSプレミアム4Kは設定でONにします。
- 対象は当日〜7日先。新作と再放送は除外せず、異なる日時の放送を別枠として扱います。
- 予定が初めて見つかったときに通知。同じ放送枠は毎回通知しません。
- 時刻変更は旧枠と一意に対応付けられた場合に変更通知。識別子がない場合は同一タイトル・同一チャンネル・24時間以内の消失枠と追加枠を照合します。曖昧な場合や大幅な変更は新規枠として通知されます。放送中止の通知は未対応です。
- 初回取得時は見つかった予定も通知対象。通知端末を後から登録した場合、過去に検出済みの枠は遡って通知せず、画面に表示します。
- 「未取得・取得失敗・自動取得未対応」を「放送予定なし」とは扱いません。
- 同じ接続キーを使う全端末で番組設定を共有。登録は最大30番組・3端末です。

**実API、実際のプッシュサービス、iPhone実機での動作確認は別途必要です。コード・テストの存在は実サービスへの接続確認を意味しません。**

## 無料・カード登録なしでの利用

GitHubの**公開**リポジトリとCloudflareの**Free**アカウントを使用します。カードを登録せず、有料プラン・従量課金を有効にしないでください。

NHK APIは無料ですが[利用登録・APIキー](https://api-portal.nhk.or.jp/)が必要です。Cloudflareもアカウント作成が必要です。

- 1時間に8回（毎時2/9/16/23/30/37/44/51分）、1回につき1日分・テレビ全チャンネルを取得。**通常192回/日**でNHKの300回/日以内。同じ時刻の重複実行はDBで抑止し、失敗時の即時再取得はしません。他のアプリとキーを共用すると合算に注意が必要です。
- 毎時51分ごろに結果を反映。1サイクルの各日付は取得時刻が異なるため、瞬時の検知ではありません。反映・配信には最大約2時間＋キュー待ちが生じることがあります。
- D1更新はJSONを使ったまとめ書き。プッシュ送信は1回のCronで最大3件。HTTPテスト通知は1分に1回まで。
- 配信失敗は最大5回再試行。404/410の期限切れ通知先は削除。90日間アプリを開いていない端末は登録を削除するため、定期的にアプリを開いてください。
- Workerのログ取得は既定でOFF。URLに含まれるNHK APIキーやPush購読情報をログ出力しません。

無料枠でもCPU時間・リクエスト数・DB読み書き上限があります。広すぎる検索語や多数の放送枠、第三者からのアクセスでは停止する可能性があります。**無料枠での実運用のCPU使用量はデプロイ後に確認してください。** 自動的に有料プランへ切り替える実装はありません。プロバイダーの将来の価格・規約変更まで無料を保証するものではありません。

参考：[Workers無料枠](https://developers.cloudflare.com/workers/platform/limits/) / [D1料金](https://developers.cloudflare.com/d1/platform/pricing/) / [NHK API仕様](https://api-portal.nhk.or.jp/pg-date-tv-v3)

## 開発

Node.js 24 LTS / npmを推奨します。

```sh
npm install
npm run dev                 # PWA画面。サーバー未接続でも番組登録は可能
npm run check               # 型検査・lint・テスト・PWAビルド・Worker dry-run/実行テスト
```

本番用の`dist/`には、内容ハッシュ付きService Workerとアセット一覧を生成します。
オフラインではアプリの殻と端末の設定だけを使い、API応答・接続キー・NHK番組表をService WorkerのCache Storageに保存しません。

### ローカルのバックエンド

`wrangler.jsonc`を`wrangler.local.jsonc`へコピーし、ローカル用に次の値へ変更します（コピーはgit管理対象外）。

```json
"APP_ORIGIN": "http://localhost:5173",
"APP_URL": "http://localhost:5173/"
```

`npm run keys`で後述のキーを生成し、`.dev.vars`に設定します。NHKキーがなければ`NHK_API_KEY`は省略でき、UIに未設定と表示されます。

```sh
npx wrangler d1 migrations apply tv-notifier --local --config wrangler.local.jsonc
npm run worker:dev
```

別ターミナルで`npm run dev`を起動し、アプリの設定に`http://localhost:8787`と生成した接続キーを入力します。
Cronを手動確認する場合はWranglerの`/__scheduled?time=...`に各分のUNIXミリ秒を指定し、8分割すべてを実行してください。同じ時間枠は再実行できません。

## 公開手順（初回のみ）

### 1. Cloudflare D1を作成

CloudflareをFreeプランで登録してから、ローカルPCで実行します。

```sh
npm install
npx wrangler login
npx wrangler d1 create tv-notifier
```

表示された`database_id`を`wrangler.jsonc`の`database_id`へ設定します。既存の値はこのリポジトリ所有者の本番DBを指します。ID自体は秘密ではありません。
フォークする場合は`APP_ORIGIN`をPagesのオリジン（パスなし）、`APP_URL`をPWAのURL（末尾`/`付き）に変更します。

```sh
npx wrangler d1 migrations apply tv-notifier --remote
```

### 2. 接続キー・VAPID鍵を作成

```sh
npm run keys
```

生成物`vapid-keys.json`に接続キーと鍵を保存します（権限0600、git管理対象外、既存ファイルは上書きしません）。**チャット・PR・スクリーンショットに貼らないでください。** バックアップは秘密情報として管理してください。

以下を対話入力でCloudflareのシークレットに保存します。コマンドライン引数に秘密値を直接書かないでください。

```sh
npx wrangler secret put OWNER_TOKEN        # 生成したOWNER_TOKEN
npx wrangler secret put VAPID_PUBLIC_KEY   # 生成したVAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY  # 生成したVAPID_PRIVATE_KEY
npx wrangler secret put NHK_API_KEY        # NHKで取得したAPIキー
npx wrangler deploy
```

VAPIDの連絡先は既定でこのリポジトリのURLです。必要なら`VAPID_SUBJECT`を自分のHTTPS URLまたは`mailto:`アドレスへ変更します。
VAPID鍵を再生成すると既存の購読を作り直す必要があります。接続キーを変更しても既存端末への通知は止まらないため、漏えい時は購読の削除も必要です。

### 3. GitHub Pagesを有効にする

1. このPRをマージ（自動マージはしません）。
2. GitHubリポジトリ **Settings → Pages → Source → GitHub Actions** を選択。
3. 任意：**Settings → Secrets and variables → Actions → Variables**に`VITE_API_URL`をWorkerのHTTPS URLとして登録。未設定なら`https://tv-notifier.daipan100g-dev.workers.dev`を使用します。**これは公開値**です。APIキーや接続キーは絶対に`VITE_*`へ入れないでください。
4. **Actions → Deploy PWA to GitHub Pages → Run workflow** を実行。
5. `https://daipan100g-dev.github.io/tv-notifier/`を開き、設定にWorker URLと個人用接続キーを入力。

Pagesワークフローは本番公開用です。PRのCIはチェックのみで、PRからデプロイしません。
Workerは別途手動でデプロイします。GitHubにCloudflareのAPIトークンを預ける必要はありません。

### 4. iPhoneで通知を有効にする

1. **iOS 16.4以降**のSafariでPagesのURLを開く。
2. 共有 → **ホーム画面に追加**。
3. 追加したアイコンから起動。ホーム画面アプリのストレージはSafariと異なることがあるため、この画面で接続キーを設定する。
4. BS/4Kを視聴できる場合は設定をONにする。
5. 設定 → **この端末の通知を有効にする** → 許可。
6. **テスト通知を送る**を押し、端末で受信を確認する。
7. 次の毎時51分以降、「放送予定」で取得状況を確認する。

Web Pushはベストエフォートです。集中モード・通知設定・通信状態で遅延/欠落することがあります。プッシュサービスの受付成功と端末への表示成功は異なります。
再試行時に受付応答が失われると、再送される可能性があります。通知タグで同一枠を置換しますが、厳密なexactly-once配信は保証しません。
[Apple/WebKitの説明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## セキュリティ・データ

- 公開Pagesに置くのは静的ファイルと任意のWorker URLのみ。個人用接続キーは端末のlocalStorage、NHK/VAPID秘密鍵はWorker Secretに保存します。共用端末では利用しないでください。
- APIは全ルートで32文字以上のBearer接続キーを要求。CORSは指定オリジンのみ許可。CORSは認証の代用ではありません。
- Push送信先はApple・Google・Mozillaの既知のHTTPSエンドポイントに限定し、リダイレクトを禁止。任意URLへのプロキシにはしません。
- D1にはお気に入り、購読情報、現在の放送枠、通知の状態を保存します。NHK応答全体・番組説明・画像は保存しません。照合用の分割取得データは2時間で削除、放送終了済みの枠は次のCron/APIアクセス時に削除します。
- 番組表の確認から2時間経った枠は画面に出さず、取得停止を表示します。バックエンドに接続できない間は最新性を主張しません。
- NHK情報には出典を表示し、履歴アーカイブやスクレイピングは行いません。[NHK利用規約](https://api-portal.nhk.or.jp/terms)・[利用ガイド](https://api-portal.nhk.or.jp/service-guide)を利用者側でも確認してください。
- 通知を停止するには各端末で解除。完全削除するにはCloudflareのWorker/CronとD1を削除し、各端末のアプリ/サイトデータも削除してください。
