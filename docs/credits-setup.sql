-- ============================================================================
--  SONGFLOW — shared credit pool + per-user caps
--  Run ONCE in Supabase → SQL Editor → New query → paste → Run.
--  Safe to re-run, and safe to run over the earlier per-user-balance version.
--
--  MODEL: one shared pool of money (your hard spending ceiling — total spend can
--  NEVER exceed it, however many people sign up). Each user has a CAP on how much
--  of that pool they may personally draw, plus an ALLOWED on/off switch.
--  A user's remaining allowance = min(cap - their spent, pool balance).
-- ============================================================================

-- 1) THE POOL — a single row holding all the money.
create table if not exists public.credit_pool (
  id         smallint primary key default 1,
  balance    numeric(12,6) not null default 50.00,   -- <-- put your funded amount here
  spent      numeric(12,6) not null default 0,
  updated_at timestamptz   not null default now(),
  constraint credit_pool_single_row check (id = 1)
);
insert into public.credit_pool (id) values (1) on conflict (id) do nothing;

-- Nobody reads or writes the pool from a browser — server only.
alter table public.credit_pool enable row level security;

-- 2) PER-USER access + usage.
create table if not exists public.credits (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- added separately so this script also upgrades the earlier version of the table
alter table public.credits add column if not exists allowed boolean       not null default true;
alter table public.credits add column if not exists cap     numeric(10,6) not null default 5.00;
alter table public.credits add column if not exists spent   numeric(10,6) not null default 0;

-- Users may READ their own row (the app shows their remaining allowance).
-- Only the server (service_role) can write.
alter table public.credits enable row level security;
drop policy if exists "read own credits" on public.credits;
create policy "read own credits" on public.credits
  for select using (auth.uid() = user_id);

-- 3) Every new signup gets a row (access on, default cap). No money is minted —
--    they simply gain permission to draw from the pool.
create or replace function public.grant_starting_credits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.credits (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_credits on auth.users;
create trigger on_auth_user_created_credits
  after insert on auth.users
  for each row execute function public.grant_starting_credits();

-- 4) Atomic spend: debit the user AND the pool in one statement so two
--    simultaneous generations can't both read a stale balance and overspend.
--    Returns the user's remaining allowance.
create or replace function public.spend_credit(p_user uuid, p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare amt numeric := greatest(0, coalesce(p_amount, 0));
        user_left numeric;
        pool_left numeric;
begin
  update public.credits
     set spent = spent + amt, updated_at = now()
   where user_id = p_user
  returning greatest(0, cap - spent) into user_left;

  update public.credit_pool
     set balance = greatest(0, balance - amt), spent = spent + amt, updated_at = now()
   where id = 1
  returning balance into pool_left;

  return least(coalesce(user_left, 0), coalesce(pool_left, 0));
end;
$$;

-- 5) Remaining allowance for a user, without spending anything.
create or replace function public.credit_remaining(p_user uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare user_left numeric; pool_left numeric; ok boolean;
begin
  select greatest(0, cap - spent), allowed into user_left, ok
    from public.credits where user_id = p_user;
  if ok is distinct from true then return 0; end if;
  select balance into pool_left from public.credit_pool where id = 1;
  return least(coalesce(user_left, 0), coalesce(pool_left, 0));
end;
$$;

-- 6) These two functions move money and read other people's usage, so ONLY the
--    server (service_role) may call them — never a browser.
revoke all on function public.spend_credit(uuid, numeric)  from public, anon, authenticated;
revoke all on function public.credit_remaining(uuid)       from public, anon, authenticated;

-- 7) Backfill anyone who signed up before this ran.
insert into public.credits (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;

-- ============================================================================
--  DAY-TO-DAY (run these on their own as needed):
--
--  How much money is left, and who's using it:
--    select balance, spent from public.credit_pool;
--    select email, allowed, cap, spent, round((cap-spent)::numeric,4) as remaining
--      from public.credits order by spent desc;
--
--  Add money to the pool (after topping up the OpenRouter key):
--    update public.credit_pool set balance = balance + 50.00 where id = 1;
--
--  Give one tester a bigger allowance (they're giving great feedback):
--    update public.credits set cap = 15.00 where email = 'tester@example.com';
--
--  Cut someone off immediately (abuse, leaked account):
--    update public.credits set allowed = false where email = 'tester@example.com';
--
--  Reset everyone's usage for a fresh round of testing:
--    update public.credits set spent = 0;
--
--  Change the default allowance for FUTURE signups:
--    alter table public.credits alter column cap set default 5.00;
-- ============================================================================
