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
2. **APIとサービス → ライブラリ** → `Google Drive API` を有効化
3. **APIとサービス → OAuth同意画面**
   - ユーザーの種類：外部
   - アプリ名／サポートメール／デベロッパー連絡先を入力
   - スコープに以下を追加
     - `.../auth/userinfo.email`
     - `.../auth/userinfo.profile`
     - `.../auth/drive.appdata`
   - 「テスト」の間は登録したテストユーザーしかログインできません。一般公開する際は**「本番環境に公開」**を実行します
     （`drive.appdata` は機微スコープではないため、通常はGoogleの審査なしで公開できます）
4. **認証情報 → OAuth 2.0 クライアントID（ウェブアプリケーション）** を作成
   - 承認済みのリダイレクトURI： `https://<プロジェクトID>.supabase.co/auth/v1/callback`
   - 承認済みのJavaScript生成元： `https://kinomin.github.io`
   - 発行された**クライアントID**と**クライアントシークレット**を控える

## 2. Supabase（認証・会員情報・決済処理）

1. [Supabase](https://supabase.com/) でプロジェクトを作成
2. **Authentication → Providers → Google** を有効化し、1で控えたクライアントID／シークレットを設定
3. **Authentication → URL Configuration**
   - Site URL： `https://kinomin.github.io/sheet-prot/`
   - Redirect URLs にも同じURLを追加
4. **SQL Editor** で [`supabase/migrations/0001_profiles.sql`](./supabase/migrations/0001_profiles.sql) の内容を実行
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

## 4. Edge Functions のデプロイ

```bash
npm install -g supabase
supabase login
supabase link --project-ref <プロジェクトID>
```

シークレットを登録します（**ここだけがシークレットの置き場所です**）。

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx STRIPE_PRICE_ID=price_xxx SITE_URL=https://kinomin.github.io/sheet-prot ALLOWED_ORIGINS=https://kinomin.github.io
```

関数をデプロイします。

```bash
supabase functions deploy create-checkout-session
```

```bash
supabase functions deploy create-portal-session
```

Webhookはログインを経由しないため、JWT検証を外してデプロイします。

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

## 5. Stripe Webhook の登録

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

## 6. アプリ側の設定

`index.html` 冒頭の `APP_CONFIG` を編集します（**すべて公開してよい値です**）。

```js
const APP_CONFIG={
  supabaseUrl:"https://xxxx.supabase.co",
  supabaseAnonKey:"eyJhbGciOi...",
  googleClientId:"xxxx.apps.googleusercontent.com",
  corporateContactUrl:"",
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

## 7. 公開前の確認

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

確認できたらStripeを**本番モード**に切り替え、本番のキー（`sk_live_...`／`price_...`／`whsec_...`）で
手順4・5のシークレットを登録し直します。

## 8. 運用について

- **有効期限切れの保険**：webhookが届かなかった場合に備え、`expire_lapsed_premium()` を1日1回実行することを推奨します
  （Supabase → Database → Cron から `select public.expire_lapsed_premium();` を登録）
- **特定商取引法に基づく表記**：有料サービスを継続的に提供する場合、事業者名・所在地・連絡先等の表示が必要です。
  公開前にご自身の状況に応じてご確認ください
- **インボイス制度**：適格請求書の発行が必要な場合は、Stripeの請求書設定をご確認ください
