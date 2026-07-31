// =============================================================
// Stripe クライアント（遅延生成）
// -------------------------------------------------------------
// 以前はモジュールの先頭で new Stripe(requireEnv(...)) していたが、
// シークレット未設定だと「モジュールの読み込み自体」が失敗する。
// その場合 Deno.serve に到達しないため、
//   ・CORSヘッダの付いた応答を返せない
//   ・OPTIONS（プリフライト）にも応答できない
// となり、ブラウザ側には原因の分からない「Failed to fetch」しか出ない。
// 呼び出し時に生成することで、未設定でも理由の分かるJSONを返せるようにする。
// =============================================================
import Stripe from "npm:stripe@17";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY が設定されていません（supabase secrets set STRIPE_SECRET_KEY=... を実行してください）",
    );
  }
  cached = new Stripe(key, {
    apiVersion: "2024-12-18.acacia",
    // Deno上では Node の http モジュールではなく fetch を使わせる
    httpClient: Stripe.createFetchHttpClient(),
  });
  return cached;
}

export type { Stripe };
