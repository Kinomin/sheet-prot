# 公開手順

一般公開までに必要な設定を、順番どおりに行えばよいようにまとめています。
所要時間の目安は 60〜90分（Stripeの本番審査を除く）。

> **絶対に守ること**
> `sk_...`（Stripeのシークレットキー）と `service_role` キーは、**`index.html` に書かない・Gitにコミットしない**。
> これらは Supabase のシークレット（サーバー側）にのみ登録します。
> このリポジトリは公開設定のため、コミットした時点で第三者に読まれます。

---

## 1. Google Cloud（ログインとドライブ保存）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. **APIとサービス → ライブラリ** → `Google Drive API` を有効化（先にこれを済ませないと、次の手順でスコープの選択肢に出てきません）
3. **APIとサービス → OAuth同意画面 → データアクセス**（「スコープ」というタブ名の場合もあります）
   - **「スコープを追加または削除」**を開く
   - 検索欄に `drive.appdata` と入力しても一覧に出てこないことがあります。
     その場合は一覧の下にある**「手動でスコープを追加」**の入力欄に、以下を1行ずつそのまま貼り付けて追加してください
     ```
     https://www.googleapis.com/auth/userinfo.email
     https://www.googleapis.com/auth/userinfo.profile
     https://www.googleapis.com/auth/drive.appdata
     ```
   - 「更新」→「保存して次へ」で確定
   - アプリ名／サポートメール／デベロッパー連絡先は「OAuth同意画面 → 基本情報」で入力
   - 「公開ステータス：テスト」の間は登録したテストユーザーしかログインできません。一般公開する際は**「本番環境に公開」**を実行します
     （`drive.appdata` は機微スコープではないため、通常はGoogleの審査なしで公開できます）
4. **APIとサービス → 認証情報 → OAuth 2.0 クライアントID（ウェブアプリケーション）** を作成
   - 承認済みのリダイレクトURI： `https://<プロジェクトID>.supabase.co/auth/v1/callback`
   - 承認済みのJavaScript生成元： `https://kinomin.github.io`
   - 発行された**クライアントID**と**クライアントシークレット**を控える

## 2. Supabase（認証・会員情報・決済処理）

1. [Supabase](https://supabase.com/) でプロジェクトを作成
2. **Authentication → Providers → Google** を有効化し、1で控えたクライアントID／シークレットを設定
3. **Authentication → URL Configuration**
   - Site URL： `https://kinomin.github.io/sheet-prot/`
   - Redirect URLs に `https://kinomin.github.io/sheet-prot/` を追加
     （アプリ側で戻り先の末尾 `index.html` は自動的に取り除きます）
4. **SQL Editor** で以下を順に実行
   1. [`supabase/migrations/0001_profiles.sql`](./supabase/migrations/0001_profiles.sql)（会員情報）
   2. [`supabase/migrations/0002_limits.sql`](./supabase/migrations/0002_limits.sql)（印刷回数の制限）
5. **Project Settings → API** から `Project URL` と `anon public` キーを控える

## 3. Stripe（決済）

1. [Stripe](https://dashboard.stripe.com/) で商品を作成
   - 商品名：プレミアム会員
   - 料金：**500円 / 年（継続）**
   - 通貨：JPY
   - 作成後の **価格ID（`price_...`）** を控える
2. **設定 → 請求 → カスタマーポータル** を有効化（解約導線に必要）
   - 「サブスクリプションのキャンセルを許可」をオンにする
3. Webhookは手順4のあとで設定します

## 4. 問い合わせの設定（スプレッドシート記録＋Gmail通知）

問い合わせ内容をGoogleスプレッドシートへ記録し、あわせてGmailで通知します。

1. Googleドライブで**スプレッドシートを新規作成**し、URLの `/d/` と `/edit` の間にある**ID**を控える
   （シートは自動で作られるので、中身は空のままで構いません）
2. [script.google.com](https://script.google.com/) で**新しいプロジェクト**を作成
3. [`google-apps-script/問い合わせ受付.gs`](./google-apps-script/問い合わせ受付.gs) の内容を貼り付け
4. **プロジェクトの設定 → スクリプト プロパティ**に以下を追加

   | プロパティ | 値 |
   |---|---|
   | `SHEET_ID` | 1で控えたスプレッドシートのID |
   | `NOTIFY_TO` | 通知を受け取るメールアドレス |
   | `SHARED_SECRET` | 推測されない文字列（例：`openssl rand -hex 24` の出力） |

5. エディタで `testSend` を実行し、**権限を承認**する
   （スプレッドシートに1行追加され、通知メールが届けば成功です）
6. **デプロイ → 新しいデプロイ → 種類：ウェブアプリ**
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員**（呼び出しはSupabase側からのみ行い、合言葉で保護します）
   - 発行された**ウェブアプリのURL**を控える

> Gmailの送信は、このスクリプトを所有するGoogleアカウントから行われます。
> 個人のGmailの送信上限は1日あたり100通程度です（Workspaceは1500通程度）。

## 5. Edge Functions のデプロイ

```bash
npm install -g supabase
supabase login
supabase link --project-ref <プロジェクトID>
```

シークレットを登録します（**ここだけがシークレットの置き場所です**）。

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_PRICE_ID=price_xxx \
  SITE_URL=https://kinomin.github.io/sheet-prot \
  ALLOWED_ORIGINS=https://kinomin.github.io \
  INQUIRY_WEBHOOK_URL=<手順4で控えたGASのURL> \
  INQUIRY_SHARED_SECRET=<手順4で決めた合言葉>
```

> **`SITE_URL` と `ALLOWED_ORIGINS` は別物です。**
> `SITE_URL` は戻り先なのでパスを含みます（`.../sheet-prot`）が、
> `ALLOWED_ORIGINS` は**オリジンだけ**（`https://kinomin.github.io`）です。
> ここへパスや末尾スラッシュを入れるとブラウザが応答を破棄し、
> 決済も問い合わせも「サーバーに接続できませんでした」で止まります。
> （表記ゆれは関数側で吸収するようにしましたが、正しい値を入れてください）

関数をデプロイします（初回・手動確認用）。

```bash
supabase functions deploy create-checkout-session
```

```bash
supabase functions deploy create-portal-session
```

```bash
supabase functions deploy send-inquiry
```

Webhookはログインを経由しないため、JWT検証を外してデプロイします。

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

### 以降の反映を自動化する（GitHub Actions）

Supabase は Git を見ていないため、`supabase/functions` を更新して `main` に反映しても、
上のコマンドを誰かが手動で実行するまでは**本番のEdge Functionsには反映されません**。
`.github/workflows/deploy-edge-functions.yml` を追加済みなので、以下の2つを
GitHubリポジトリの **Settings → Secrets and variables → Actions** に登録すれば、
`supabase/functions/**` を変更して `main` にマージするたびに自動デプロイされます。

| Secret名 | 値 | 取得方法 |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | 個人アクセストークン | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) で発行 |
| `SUPABASE_PROJECT_REF` | プロジェクトID | Supabaseの管理画面URLの一部（`https://supabase.com/dashboard/project/<ここ>`） |

登録すると、Actionsタブから `Deploy Supabase Edge Functions` を手動実行（`workflow_dispatch`）することもできます。
なお、これはEdge Functionsのコードのみを反映するもので、`supabase secrets set` によるシークレットの登録や、
`supabase/migrations/*.sql` の適用は含まれません（別途手動で行ってください）。

## 6. Stripe Webhook の登録

1. Stripe → **開発者 → Webhook → エンドポイントを追加**
2. URL： `https://<プロジェクトID>.supabase.co/functions/v1/stripe-webhook`
3. 送信するイベント：
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. 発行された **署名シークレット（`whsec_...`）** を登録

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
```

## 7. アプリ側の設定

`index.html` 冒頭の `APP_CONFIG` を編集します（**すべて公開してよい値です**）。

```js
const APP_CONFIG={
  supabaseUrl:"https://xxxx.supabase.co",
  supabaseAnonKey:"eyJhbGciOi...",
  googleClientId:"xxxx.apps.googleusercontent.com",
  supportEmail:"あなたの連絡先@example.com",
  premiumPriceLabel:"500円 / 年",
  termsUrl:"./terms.html",
  privacyUrl:"./privacy.html",
};
```

コミットして公開します。

```bash
git add -A && git commit -m "本番設定を反映" && git push
```

## 8. 公開前の確認

Stripeを**テストモード**にして、以下を通しで確認してください。

- [ ] Googleでログインでき、ドライブ利用の同意画面が表示される
- [ ] 別の端末（またはシークレットウィンドウ）で同じアカウントにログインし、座席表が引き継がれる
- [ ] 片方の端末で削除すると、もう片方でも消える
- [ ] テストカード `4242 4242 4242 4242` で決済でき、数秒後に「プレミアム」表示になる
- [ ] Supabaseの `profiles` テーブルで `plan` が `premium` になっている
- [ ] 「お支払い・解約の管理」からStripeの画面が開き、解約できる
- [ ] 解約すると期限日以降に `plan` が `free` に戻る
- [ ] 別のGoogleアカウントでログインした際、他人の名簿が表示されない
- [ ] スマートフォンで座席表の作成・印刷ができる
- [ ] **無料会員**で印刷を4回試し、4回目に「印刷回数を使い切りました」が出る
- [ ] 無料会員では設定メニューに「今すぐ同期」が出ず、端末間で引き継がれない
- [ ] プレミアム会員になると印刷が無制限になり、端末間の引き継ぎが有効になる
- [ ] 問い合わせを送信すると、スプレッドシートに行が追加されGmailに通知が届く
- [ ] 続けて問い合わせを送ると、60秒間は送信できない旨が表示される

## 9. Stripeを本番モードへ切り替える

テストモードと本番モードは**別の環境**です。商品・Webhook・カスタマーポータルの設定は
共有されないため、それぞれ本番側で作り直す必要があります。

1. Stripeダッシュボード右上のトグルを**本番環境**へ切り替える
2. **商品を作成**（テストモードのものは使えません）
   - 商品名：プレミアム会員／料金：**500円 / 年（継続）**／通貨：JPY
   - 本番の**価格ID（`price_...`）** を控える
3. **設定 → 請求 → カスタマーポータル**を本番側でも有効化し、
   「サブスクリプションのキャンセルを許可」をオンにする（テスト側の設定は引き継がれません）
4. **開発者 → APIキー**から本番のシークレットキー（`sk_live_...`）を控える
5. **開発者 → Webhook → エンドポイントを追加**（本番側で作り直す）
   - URL： `https://<プロジェクトID>.supabase.co/functions/v1/stripe-webhook`
   - イベントは手順6と同じ5種類
   - 本番の**署名シークレット（`whsec_...`）** を控える
6. シークレットを本番の値で登録し直す

   ```bash
   supabase secrets set \
     STRIPE_SECRET_KEY=sk_live_xxx \
     STRIPE_PRICE_ID=price_xxx \
     STRIPE_WEBHOOK_SECRET=whsec_xxx
   ```

   > シークレットを更新すれば次回の呼び出しから反映されます。関数の再デプロイは不要です。
   > `SITE_URL`・`ALLOWED_ORIGINS`・問い合わせ関連はテスト時のままで構いません。

7. **本番で疎通確認**。テストカード（`4242...`）は使えないため、
   実際のカードで1件申し込み → `profiles.plan` が `premium` になることを確認 →
   カスタマーポータルから解約、という流れで確認します
   （年額のため、確認後すぐ解約すれば請求は残りますが返金処理はStripeから行えます）
8. 事業者情報（特定商取引法に基づく表記）を掲載してから公開する（下記10を参照）

### 決済・問い合わせが動かないときの確認順

| 症状 | 確認すること |
|---|---|
| 「サーバーに接続できませんでした」 | `ALLOWED_ORIGINS` がオリジンだけになっているか。関数がデプロイ済みか |
| 「STRIPE_SECRET_KEY が設定されていません」 | `supabase secrets list` で登録内容を確認 |
| 「送信できませんでした（unauthorized）」 | `INQUIRY_SHARED_SECRET` とGAS側の `SHARED_SECRET` の不一致 |
| 「送信できませんでした（スクリプトプロパティが未設定です）」 | GASのスクリプトプロパティ（`SHEET_ID`ほか）の設定漏れ |
| 決済は完了したがプレミアムにならない | Stripe → Webhook でエラーが出ていないか。`supabase functions logs stripe-webhook` |

関数側のログは `supabase functions logs <関数名>` で確認できます。

## 10. 運用について

- **有効期限切れの保険**：webhookが届かなかった場合に備え、`expire_lapsed_premium()` を1日1回実行することを推奨します
  （Supabase → Database → Cron から `select public.expire_lapsed_premium();` を登録）
- **特定商取引法に基づく表記**：有料サービスを継続的に提供する場合、事業者名・所在地・連絡先等の表示が必要です。
  公開前にご自身の状況に応じてご確認ください
- **インボイス制度**：適格請求書の発行が必要な場合は、Stripeの請求書設定をご確認ください
