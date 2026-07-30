// =============================================================
// 解約・支払い方法の変更（Stripe カスタマーポータル）
// -------------------------------------------------------------
// 解約はStripeの正規の画面で行ってもらう。アプリ側で表示だけ切り替えても
// 自動更新は止まらないため、必ずこの導線を用意する。
// =============================================================
import Stripe from "npm:stripe@17";
import { getProfile, getUser, json, preflight, requireEnv } from "../_shared/util.ts";

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), { apiVersion: "2024-12-18.acacia" });

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const user = await getUser(req);
    const profile = await getProfile(user.id);
    const customerId = (profile?.stripe_customer_id as string | null) ?? null;

    if (!customerId) {
      return json(req, { error: "お支払いの記録が見つかりませんでした" }, 404);
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: requireEnv("SITE_URL").replace(/\/+$/, "") + "/",
      locale: "ja",
    });

    return json(req, { url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("create-portal-session:", message);
    return json(req, { error: message }, 400);
  }
});
