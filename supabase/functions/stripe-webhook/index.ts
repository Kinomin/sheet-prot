// =============================================================
// Stripe からの通知を受けて会員種別を更新する
// -------------------------------------------------------------
// 会員種別を書き換えられるのはこの関数だけ（クライアントからは更新不可）。
// 必ず署名を検証し、Stripeからの通知であることを確かめてから処理する。
//
// ※この関数はJWT検証を無効にしてデプロイすること（Stripeはログインしないため）
//    supabase functions deploy stripe-webhook --no-verify-jwt
// =============================================================
import type Stripe from "npm:stripe@17";
import { getStripe } from "../_shared/stripe.ts";
import { db } from "../_shared/util.ts";

/**
 * Stripeの顧客IDから会員を特定して更新する。
 * 顧客IDで見つからない場合は、metadataに載せてある利用者IDで取り直す
 * （申し込み前にprofilesの行が無かった等で顧客IDが保存されていない場合の保険）。
 */
async function updateByCustomer(
  customerId: string,
  patch: Record<string, unknown>,
  fallbackUserId?: string | null,
): Promise<void> {
  const res = await db(`profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`会員情報の更新に失敗: ${await res.text()}`);
  const rows = await res.json();
  if (rows.length) return;

  if (!fallbackUserId) {
    console.warn(`該当する会員が見つかりません customer=${customerId}`);
    return;
  }

  // 顧客IDごと結び付け直す
  const retry = await db(`profiles?id=eq.${encodeURIComponent(fallbackUserId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, stripe_customer_id: customerId }),
  });
  if (!retry.ok) throw new Error(`会員情報の更新に失敗: ${await retry.text()}`);
  const retryRows = await retry.json();
  if (!retryRows.length) {
    console.warn(`該当する会員が見つかりません customer=${customerId} user=${fallbackUserId}`);
  }
}

/** 有効期限を取り出す。Stripe API 2025-03-31(basil) 以降は購読アイテム側へ移動している */
function periodEndOf(sub: Stripe.Subscription): string | null {
  const raw = sub as unknown as {
    current_period_end?: number;
    items?: { data?: Array<{ current_period_end?: number }> };
  };
  const at = raw.current_period_end ?? raw.items?.data?.[0]?.current_period_end;
  return typeof at === "number" ? new Date(at * 1000).toISOString() : null;
}

/** 購読の状態を会員種別へ翻訳する */
function planFromSubscription(sub: Stripe.Subscription): Record<string, unknown> {
  // active / trialing の間だけプレミアム扱い。
  // 支払い失敗(past_due)や解約済み(canceled)は無料へ戻す。
  const premium = sub.status === "active" || sub.status === "trialing";
  return {
    plan: premium ? "premium" : "free",
    stripe_subscription_id: sub.id,
    current_period_end: periodEndOf(sub),
    cancel_at_period_end: !!sub.cancel_at_period_end,
  };
}

/** 購読のmetadataから利用者IDを取り出す */
function userIdOf(sub: Stripe.Subscription): string | null {
  return (sub.metadata?.supabase_user_id as string | undefined) ?? null;
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("署名がありません", { status: 400 });

  let stripe: ReturnType<typeof getStripe>;
  let event: Stripe.Event;
  try {
    stripe = getStripe();
    const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET が設定されていません");
    // 署名検証には生のリクエストボディが必要
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(body, signature, secret);
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
          if (customerId) {
            await updateByCustomer(customerId, planFromSubscription(sub), userId ?? userIdOf(sub));
          }
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
          await updateByCustomer(customerId, patch, userIdOf(sub));
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
