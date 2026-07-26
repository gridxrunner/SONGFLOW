-- ============================================================================
--  SONGFLOW — tester credit ledger
--  Run ONCE in Supabase → SQL Editor → New query → paste → Run.
--  Safe to re-run (everything is create-if-not-exists / or-replace).
-- ============================================================================

-- 1) The ledger. One row per user. Balance is in US dollars.
create table if not exists public.credits (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  balance    numeric(10,6) not null default 5.00,   -- <-- the per-tester grant
  spent      numeric(10,6) not null default 0,
  created_at timestamptz   not null default now(),
  updated_at timestamptz   not null default now()
);

-- 2) Lock it down. Users may READ their own balance (the app shows a meter).
--    Nobody can write from the browser — only the server function (service_role) moves money.
alter table public.credits enable row level security;

drop policy if exists "read own balance" on public.credits;
create policy "read own balance" on public.credits
  for select using (auth.uid() = user_id);

-- 3) Every new signup automatically gets the starting grant.
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

-- 4) Atomic spend. Doing this in one statement prevents two simultaneous
--    generations from both reading the old balance and over-spending.
create or replace function public.spend_credit(p_user uuid, p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare new_balance numeric;
begin
  update public.credits
     set balance    = greatest(0, balance - greatest(0, coalesce(p_amount, 0))),
         spent      = spent + greatest(0, coalesce(p_amount, 0)),
         updated_at = now()
   where user_id = p_user
  returning balance into new_balance;
  return coalesce(new_balance, 0);
end;
$$;

-- 5) Backfill: give the grant to anyone who signed up BEFORE this ran.
insert into public.credits (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;

-- ============================================================================
--  USEFUL LATER (run on their own, not part of setup):
--
--  See everyone's usage:
--    select email, balance, spent, updated_at from public.credits order by spent desc;
--
--  Top someone back up to $5:
--    update public.credits set balance = 5.00 where email = 'tester@example.com';
--
--  Give everyone another $5:
--    update public.credits set balance = balance + 5.00;
-- ============================================================================
