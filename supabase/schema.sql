-- Fridge to Feast: database setup for sign-in.
-- Run once in Supabase: SQL Editor -> New query -> paste this whole file -> Run.
-- Safe to run again: it only creates things that don't exist yet and replaces the policies.

-- One row per signed-in person, holding their saved app data
-- (kitchen, staples, plan, grocery list, diet settings) as one JSON object.
create table if not exists public.user_data (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  -- Keep each person's saved data under about 1 MB, so nobody can fill the free database.
  constraint user_data_size check (pg_column_size(data) < 1000000)
);

-- Row Level Security: the database itself only lets each person touch their own row.
alter table public.user_data enable row level security;

drop policy if exists "Read own data"   on public.user_data;
drop policy if exists "Add own data"    on public.user_data;
drop policy if exists "Change own data" on public.user_data;
drop policy if exists "Delete own data" on public.user_data;

create policy "Read own data"   on public.user_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "Add own data"    on public.user_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Change own data" on public.user_data for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own data" on public.user_data for delete to authenticated using ((select auth.uid()) = user_id);

-- Signed-in users may use the table at all (newer Supabase projects don't grant this automatically;
-- without it every save fails with "permission denied for table user_data"). The policies above
-- still limit each person to their own row.
grant select, insert, update, delete on public.user_data to authenticated;

-- Visitors who aren't signed in get no access at all.
revoke all on public.user_data from anon;
