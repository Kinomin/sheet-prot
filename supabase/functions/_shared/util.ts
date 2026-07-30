// =============================================================
// Edge Functions 共通処理
// =============================================================

/** 呼び出しを許可する画面のURL（カンマ区切りで環境変数 ALLOWED_ORIGINS に設定） */
function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const list = allowedOrigins();
  // 許可リストにない場合は最初の登録済みオリジンを返し、他サイトからの利用を防ぐ
  const allow = list.includes(origin) ? origin : (list[0] ?? "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS"
    ? new Response("ok", { headers: corsHeaders(req) })
    : null;
}

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`環境変数 ${name} が設定されていません`);
  return v;
}

/**
 * リクエストのJWTを検証し、ログイン中の利用者を返す。
 * 検証はSupabaseのAuth APIに任せる（改ざんされたトークンはここで弾かれる）。
 */
export async function getUser(req: Request): Promise<{ id: string; email: string }> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new Error("ログインが必要です");

  const res = await fetch(`${requireEnv("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: requireEnv("SUPABASE_ANON_KEY") },
  });
  if (!res.ok) throw new Error("ログイン情報を確認できませんでした");
  const user = await res.json();
  if (!user?.id) throw new Error("ログイン情報を確認できませんでした");
  return { id: user.id, email: user.email ?? "" };
}

/** service_role キーでのデータベース操作（RLSを迂回するのでサーバー内でのみ使う） */
export async function db(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function getProfile(userId: string): Promise<Record<string, unknown> | null> {
  const res = await db(`profiles?id=eq.${userId}&select=*`);
  if (!res.ok) throw new Error("会員情報を取得できませんでした");
  const rows = await res.json();
  return rows[0] ?? null;
}

export async function updateProfile(userId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await db(`profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`会員情報を更新できませんでした: ${await res.text()}`);
}
