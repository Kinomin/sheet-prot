// =============================================================
// 問い合わせの送信
// -------------------------------------------------------------
// ブラウザからGoogle Apps ScriptのURLを直接叩かせず、ここを経由させる。
//   ・ログイン中の利用者だけが送れる
//   ・60秒に1件までに制限（連続送信の防止）
//   ・GASのURLと合言葉はサーバー側のシークレットに置く
// GAS側でスプレッドシートへの記録とGmailでの通知を行う。
// =============================================================
import { getProfile, getUser, json, preflight, requireEnv } from "../_shared/util.ts";

const MAX_MESSAGE = 4000;
const CATEGORIES = ["不具合の報告", "使い方の質問", "機能のご要望", "お支払いについて", "法人契約について", "その他"];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const user = await getUser(req);
    const body = await req.json().catch(() => ({}));

    const category = CATEGORIES.includes(body.category) ? body.category : "その他";
    const message = String(body.message ?? "").trim();
    const name = String(body.name ?? "").trim().slice(0, 100);
    const email = String(body.email ?? user.email ?? "").trim().slice(0, 200);

    if (!message) return json(req, { error: "内容を入力してください" }, 400);
    if (message.length > MAX_MESSAGE) {
      return json(req, { error: `内容は${MAX_MESSAGE}文字以内で入力してください` }, 400);
    }

    // 連続送信の防止（データベース側で60秒の間隔を確認する）
    const okRes = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/rpc/touch_inquiry`, {
      method: "POST",
      headers: {
        apikey: requireEnv("SUPABASE_ANON_KEY"),
        Authorization: req.headers.get("Authorization") ?? "",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const allowed = okRes.ok ? await okRes.json() : false;
    if (allowed !== true) {
      return json(req, { error: "続けての送信はできません。少し時間をおいてお試しください" }, 429);
    }

    const profile = await getProfile(user.id);

    const res = await fetch(requireEnv("INQUIRY_WEBHOOK_URL"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: requireEnv("INQUIRY_SHARED_SECRET"),
        category,
        name,
        email,
        message,
        plan: (profile?.plan as string) ?? "free",
        userAgent: req.headers.get("User-Agent") ?? "",
        userId: user.id,
      }),
      redirect: "follow", // Apps Scriptはリダイレクトを挟むため
    });

    const text = await res.text();
    let result: { ok?: boolean; error?: string } = {};
    try { result = JSON.parse(text); } catch { /* GAS側がHTMLを返した場合 */ }

    if (!res.ok || result.ok !== true) {
      console.error("問い合わせの転送に失敗:", res.status, text.slice(0, 300));
      return json(req, { error: "送信できませんでした。時間をおいてお試しください" }, 502);
    }

    return json(req, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("send-inquiry:", message);
    return json(req, { error: message }, 400);
  }
});
