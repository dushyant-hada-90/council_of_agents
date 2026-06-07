-- Custom username/password auth (no Supabase Auth / email confirmation)

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_users_username_unique unique (username),
  constraint app_users_username_format check (username ~ '^[a-zA-Z0-9_]{3,32}$')
);

create index if not exists app_users_username_idx on public.app_users(username);

-- Repoint user_id foreign keys from auth.users → app_users (safe if tables are empty / dev)
alter table if exists public.agents drop constraint if exists agents_user_id_fkey;
alter table if exists public.meetings drop constraint if exists meetings_user_id_fkey;
alter table if exists public.transcript_messages drop constraint if exists transcript_messages_user_id_fkey;

alter table public.agents
  add constraint agents_user_id_fkey
  foreign key (user_id) references public.app_users(id) on delete cascade;

alter table public.meetings
  add constraint meetings_user_id_fkey
  foreign key (user_id) references public.app_users(id) on delete cascade;

alter table public.transcript_messages
  add constraint transcript_messages_user_id_fkey
  foreign key (user_id) references public.app_users(id) on delete cascade;

-- profiles table was tied to Supabase Auth — no longer needed
drop table if exists public.profiles cascade;

-- Disable RLS on app_users; access is via service role + app session checks
alter table public.app_users enable row level security;

-- No public API access to credentials table
create policy "No direct app_users access"
  on public.app_users for all
  using (false)
  with check (false);

create trigger app_users_updated_at before update on public.app_users
  for each row execute function public.set_updated_at();
