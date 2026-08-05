-- =============================================================
-- 会員種別による機能制限
-- -------------------------------------------------------------
--   無料会員   … 印刷3回まで／端末間の引き継ぎなし
--   プレミアム … 印刷無制限／端末間の引き継ぎあり
--
-- 印刷回数はブラウザ側に持たせると消して回避できてしまうため、
-- ここ（サーバー）で数える。
-- =============================================================

alter table public.profiles
  add column if not exists print_count      integer     not null default 0,
  add column if not exists last_inquiry_at  timestamptz;

comment on column public.profiles.print_count is '無料会員の印刷回数。consume_print()からのみ増える。';

-- クライアントが直接書き換えられないよう、更新可能な列は表示名のみのまま
-- （0001で grant update (display_name) 済み。print_count は含めない）

-- 無料会員の印刷上限
create or replace function public.free_print_limit()
returns integer language sql immutable as $$ select 3 $$;

-- この関数は定数を返すだけで、会員情報にも生徒の情報にも触れないため、
-- 誰が呼んでも差し支えない（下のconsume_print等とは違いrevokeしない）。
--
-- ★この権限には依存関係がある★
-- Supabaseの無料プランは一定期間アクセスが無いとプロジェクトが一時停止される。
-- それを防ぐ .github/workflows/keep-supabase-awake.yml が、anonキーで
-- この関数を定期的に呼んでデータベースを起こしている。
-- Postgresは新しい関数のexecuteを既定でpublicへ付与するため今も呼べているが、
-- 既定任せだと意図せず失われるので、明示的に付与しておく。
-- ここを revoke すると定期アクセスが失敗し、やがてプロジェクトが停止する。
grant execute on function public.free_print_limit() to anon, authenticated;

-- -------------------------------------------------------------
-- 印刷を1回消費する。
-- security definer なので profiles を直接更新できるが、
-- 対象は必ず auth.uid()（呼び出した本人）に限定している。
-- -------------------------------------------------------------
create or replace function public.consume_print()
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  me     public.profiles%rowtype;
  lim    integer := public.free_print_limit();
begin
  if auth.uid() is null then
    return json_build_object('allowed', false, 'reason', 'not_signed_in');
  end if;

  -- 同時に複数タブから押された場合も二重に消費しないよう行ロックを取る
  select * into me from public.profiles where id = auth.uid() for update;

  -- 会員情報がまだ無い場合（サインアップ時のトリガーが動かなかった等）は、
  -- ここで作ってから続ける。無いことを理由に印刷を止めると
  -- 「使い切りました」と誤って表示されてしまうため。
  if not found then
    insert into public.profiles (id) values (auth.uid())
    on conflict (id) do nothing;
    select * into me from public.profiles where id = auth.uid() for update;
    if not found then
      return json_build_object('allowed', false, 'reason', 'no_profile');
    end if;
  end if;

  if me.plan = 'premium' then
    return json_build_object('allowed', true, 'unlimited', true);
  end if;

  if me.print_count >= lim then
    return json_build_object('allowed', false, 'reason', 'limit_reached',
                             'used', me.print_count, 'limit', lim);
  end if;

  update public.profiles
     set print_count = print_count + 1
   where id = auth.uid();

  return json_build_object('allowed', true, 'unlimited', false,
                           'used', me.print_count + 1, 'limit', lim,
                           'remaining', lim - me.print_count - 1);
end $$;

revoke all on function public.consume_print() from public, anon;
grant execute on function public.consume_print() to authenticated;

-- -------------------------------------------------------------
-- 問い合わせの連続送信を防ぐための記録（60秒に1件まで）
-- -------------------------------------------------------------
create or replace function public.touch_inquiry()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  last timestamptz;
begin
  if auth.uid() is null then return false; end if;
  select last_inquiry_at into last from public.profiles where id = auth.uid() for update;
  if last is not null and last > now() - interval '60 seconds' then
    return false;
  end if;
  update public.profiles set last_inquiry_at = now() where id = auth.uid();
  return true;
end $$;

revoke all on function public.touch_inquiry() from public, anon;
grant execute on function public.touch_inquiry() to authenticated;
