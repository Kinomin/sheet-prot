// =============================================================
// プレミアム会員の申し込み（Stripe Checkout セッションの作成）
// -------------------------------------------------------------
// クライアントからは金額も商品も指定させない。サーバー側の STRIPE_PRICE_ID を
// 必ず使うことで、価格を書き換えられる余地をなくしている。
// =============================================================
import Stripe from "npm:stripe@17";
import { getProfile, getUser, json, preflight, requireEnv, updateProfile } from "../_shared/util.ts";

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), { apiVersion: "2024-12-18.acacia" });

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const user = await getUser(req);
    const profile = await getProfile(user.id);

    // すでに有効なプレミアム会員なら、二重に購読させない
    if (profile?.plan === "premium") {
      return json(req, { error: "すでにプレミアム会員です" }, 409);
    }

    // Stripeの顧客を用意する（既にあれば使い回す）
    let customerId = (profile?.stripe_customer_id as string | null) ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await updateProfile(user.id, { stripe_customer_id: customerId });
    }

    const siteUrl = requireEnv("SITE_URL").replace(/\/+$/, "");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: requireEnv("STRIPE_PRICE_ID"), quantity: 1 }],
      success_url: `${siteUrl}/?checkout=success`,
      cancel_url: `${siteUrl}/?checkout=cancel`,
      locale: "ja",
      allow_promotion_codes: true,
      // webhook側で確実に本人と結び付けられるようにする
      client_reference_id: user.id,
      subscription_data: { metadata: { supabase_user_id: user.id } },
      metadata: { supabase_user_id: user.id },
    });

    return json(req, { url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("create-checkout-session:", message);
    return json(req, { error: message }, 400);
  }
});
