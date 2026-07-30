-- =============================================================
-- 会員情報テーブル
-- -------------------------------------------------------------
-- ここには「誰が」「どの会員種別か」だけを保存する。
-- 生徒の名簿（氏名・ふりがな・性別）は利用者本人のGoogleドライブに置き、
-- このデータベースには一切保存しない。預かる個人情報を最小限にするため。
-- =============================================================

create table if not exists public.profiles (
  id                      uuid primary key references auth.users on delete cascade,
  email                   text,
  display_name            text,
  plan                    text not null default 'free' check (plan in ('free','premium')),
  stripe_customer_id      text unique,
  stripe_subscription_id  text,
  current_period_end      timestamptz,          -- 有効期限（この日時までプレミアム）
  cancel_at_period_end    boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table  public.profiles is '会員情報。生徒の個人情報は保存しない。';
comment on column public.profiles.plan is 'free | premium。Stripeのwebhookからのみ更新される。';

alter table public.profiles enable row level security;

-- 自分の行だけ読める
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- 自分の行だけ更新できる（更新できる列は下の grant で表示名のみに絞る）
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ★重要★
-- RLSは行単位までしか制御できないため、列単位の権限で plan を守る。
-- これがないと、利用者が自分の plan を 'premium' に書き換えられてしまう。
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- 更新時刻の自動更新
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- サインアップ時に会員情報を自動で作る
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 有効期限が切れたプレミアムを無料へ戻す。
-- webhookが届かなかった場合の保険として、cronから定期実行することを想定。
create or replace function public.expire_lapsed_premium()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles
     set plan = 'free'
   where plan = 'premium'
     and current_period_end is not null
     and current_period_end < now();
$$;
