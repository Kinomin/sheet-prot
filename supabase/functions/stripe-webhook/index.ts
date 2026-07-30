// =============================================================
// Stripe からの通知を受けて会員種別を更新する
// -------------------------------------------------------------
// 会員種別を書き換えられるのはこの関数だけ（クライアントからは更新不可）。
// 必ず署名を検証し、Stripeからの通知であることを確かめてから処理する。
//
// ※この関数はJWT検証を無効にしてデプロイすること（Stripeはログインしないため）
//    supabase functions deploy stripe-webhook --no-verify-jwt
// =============================================================
import Stripe from "npm:stripe@17";
import { db, requireEnv } from "../_shared/util.ts";

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), { apiVersion: "2024-12-18.acacia" });

/** Stripeの顧客IDから会員を特定して更新する */
async function updateByCustomer(customerId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await db(`profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`会員情報の更新に失敗: ${await res.text()}`);
  const rows = await res.json();
  if (!rows.length) console.warn(`該当する会員が見つかりません customer=${customerId}`);
}

/** 購読の状態を会員種別へ翻訳する */
function planFromSubscription(sub: Stripe.Subscription): Record<string, unknown> {
  // active / trialing の間だけプレミアム扱い。
  // 支払い失敗(past_due)や解約済み(canceled)は無料へ戻す。
  const premium = sub.status === "active" || sub.status === "trialing";
  return {
    plan: premium ? "premium" : "free",
    stripe_subscription_id: sub.id,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
  };
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("署名がありません", { status: 400 });

  let event: Stripe.Event;
  try {
    // 署名検証には生のリクエストボディが必要
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      requireEnv("STRIPE_WEBHOOK_SECRET"),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("署名の検証に失敗:", message);
    return new Response(`署名の検証に失敗: ${message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ??
          (session.metadata?.supabase_user_id as string | undefined);
        const customerId = typeof session.customer === "string" ? session.customer : null;

        // 申し込み直後に顧客IDを確実に結び付けておく
        if (userId && customerId) {
          await db(`profiles?id=eq.${userId}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ stripe_customer_id: customerId }),
          });
        }
        // 実際の有効化は subscription の内容から行う
        if (typeof session.subscription === "string") {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          if (customerId) await updateByCustomer(customerId, planFromSubscription(sub));
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : null;
        if (customerId) {
          const patch = event.type === "customer.subscription.deleted"
            ? { plan: "free", cancel_at_period_end: false, stripe_subscription_id: null }
            : planFromSubscription(sub);
          await updateByCustomer(customerId, patch);
        }
        break;
      }

      case "invoice.payment_failed": {
        // 支払い失敗のみでは即座に停止しない（Stripeの再試行と猶予に任せる）。
        // 最終的に購読が past_due / canceled になれば上の分岐で無料へ戻る。
        const invoice = event.data.object as Stripe.Invoice;
        console.warn("支払いに失敗しました customer=", invoice.customer);
        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("webhook処理でエラー:", message);
    // 500を返すとStripeが再送してくれる
    return new Response(message, { status: 500 });
  }
});
