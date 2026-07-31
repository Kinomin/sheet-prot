// =============================================================
// Edge Functions 共通処理
// =============================================================

/**
 * オリジンの表記ゆれを吸収する。
 * ALLOWED_ORIGINS には本来 "https://example.github.io" のようなオリジンだけを書くが、
 * SITE_URL と取り違えてパス付き（.../sheet-prot）や末尾スラッシュ付きで登録されがち。
 * そのまま比較すると永久に一致せず、ブラウザ側は原因の分からない
 * 「Failed to fetch」になるため、ここで正規化してから突き合わせる。
 */
function normalizeOrigin(value: string): string {
  const v = value.trim();
  if (!v || v === "*") return v;
  try {
    return new URL(v).origin.toLowerCase();
  } catch {
    return v.replace(/\/+$/, "").toLowerCase();
  }
}

/** 呼び出しを許可する画面のURL（カンマ区切りで環境変数 ALLOWED_ORIGINS に設定） */
function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",").map(normalizeOrigin).filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = (req.headers.get("Origin") ?? "").trim();
  const list = allowedOrigins();

  let allow: string;
  if (!list.length || list.includes("*")) {
    // 未設定のまま空文字を返すと、ブラウザは全ての応答を破棄してしまう
    // （関数自体は正常に動いているのに、画面上は何も起きないように見える）。
    // 認証はAuthorizationヘッダのJWTで行いCookieを使わないため、
    // 未設定時は呼び出し元をそのまま許可して「動く既定値」にしておく。
    allow = origin || "*";
  } else if (list.includes(normalizeOrigin(origin))) {
    allow = origin;
  } else {
    // 許可リストにない場合は登録済みのオリジンを返し、他サイトからの利用を防ぐ
    allow = list[0];
  }

  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
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

/**
 * 会員情報の行が必ず存在する状態にしてから返す。
 * サインアップ時のトリガー（handle_new_user）が動かなかった場合、行が無いまま
 * PATCH しても PostgREST は0件更新を成功として返すため、stripe_customer_id が
 * 保存されず「支払ったのにプレミアムにならない」状態になる。その取りこぼしを防ぐ。
 */
export async function ensureProfile(
  userId: string,
  email: string,
): Promise<Record<string, unknown>> {
  const existing = await getProfile(userId);
  if (existing) return existing;

  const res = await db("profiles", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ id: userId, email: email || null }),
  });
  if (!res.ok) throw new Error(`会員情報を作成できませんでした: ${await res.text()}`);

  const created = await getProfile(userId);
  if (!created) throw new Error("会員情報を作成できませんでした");
  return created;
}

export async function updateProfile(userId: string, patch: Record<string, unknown>): Promise<void> {
  // return=representation にして、実際に更新された行数を確認する
  // （0件でも PATCH は成功扱いになるため、黙って握りつぶさないようにする）
  const res = await db(`profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`会員情報を更新できませんでした: ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("会員情報が見つかりませんでした（profiles に行がありません）");
  }
}
