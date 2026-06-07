-- =============================================================================
-- Council of Agents — complete database schema
-- Run this once in Supabase SQL Editor (fresh project or empty public schema)
-- =============================================================================

-- Shared trigger: auto-update updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- app_users — username/password login (no Supabase Auth / no email)
-- Passwords are bcrypt hashes; only the app server writes here (service role).
-- -----------------------------------------------------------------------------
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

create index if not exists app_users_username_idx on public.app_users (username);

create trigger app_users_updated_at
  before update on public.app_users
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- agents — AI advisor definitions (owned by one user)
-- -----------------------------------------------------------------------------
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  name text not null,
  description text not null default '',
  system_prompt text not null,
  voice text not null default 'alloy',
  provider text not null default 'openai',
  model text not null default 'gpt-realtime-2',
  color text not null default '#3b82f6',
  role_summary text not null default '',
  peer_profile text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agents_user_id_idx on public.agents (user_id);

create trigger agents_updated_at
  before update on public.agents
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- meetings — voice conference sessions
-- -----------------------------------------------------------------------------
create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  topic text not null default '',
  goal text not null default '',
  context text not null default '',
  instructions text not null default '',
  max_ai_turns_before_human int not null default 4
    check (max_ai_turns_before_human in (2, 4, 6)),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'active', 'ended', 'cancelled')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meetings_user_id_idx on public.meetings (user_id);
create index if not exists meetings_status_idx on public.meetings (status);

create trigger meetings_updated_at
  before update on public.meetings
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- meeting_agents — which agents participate in a meeting
-- -----------------------------------------------------------------------------
create table if not exists public.meeting_agents (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  sort_order int not null default 0,
  unique (meeting_id, agent_id)
);

create index if not exists meeting_agents_meeting_id_idx on public.meeting_agents (meeting_id);
create index if not exists meeting_agents_agent_id_idx on public.meeting_agents (agent_id);

-- -----------------------------------------------------------------------------
-- transcript_messages — persisted meeting transcript lines
-- -----------------------------------------------------------------------------
create table if not exists public.transcript_messages (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  speaker_id text not null,
  speaker_name text not null,
  speaker_type text not null check (speaker_type in ('human', 'agent')),
  message text not null,
  message_timestamp timestamptz not null default now(),
  partial boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists transcript_messages_meeting_id_idx
  on public.transcript_messages (meeting_id);
create index if not exists transcript_messages_user_id_idx
  on public.transcript_messages (user_id);
create index if not exists transcript_messages_timestamp_idx
  on public.transcript_messages (meeting_id, message_timestamp);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- The app uses the service role on the server (bypasses RLS).
-- Block direct client/API access via anon & authenticated roles.
-- -----------------------------------------------------------------------------
alter table public.app_users enable row level security;
alter table public.agents enable row level security;
alter table public.meetings enable row level security;
alter table public.meeting_agents enable row level security;
alter table public.transcript_messages enable row level security;

drop policy if exists "No direct app_users access" on public.app_users;
create policy "No direct app_users access"
  on public.app_users for all
  using (false) with check (false);

drop policy if exists "No direct agents access" on public.agents;
create policy "No direct agents access"
  on public.agents for all
  using (false) with check (false);

drop policy if exists "No direct meetings access" on public.meetings;
create policy "No direct meetings access"
  on public.meetings for all
  using (false) with check (false);

drop policy if exists "No direct meeting_agents access" on public.meeting_agents;
create policy "No direct meeting_agents access"
  on public.meeting_agents for all
  using (false) with check (false);

drop policy if exists "No direct transcript_messages access" on public.transcript_messages;
create policy "No direct transcript_messages access"
  on public.transcript_messages for all
  using (false) with check (false);

-- Cleanup legacy objects from older Supabase Auth setup (safe if never created)
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.profiles cascade;
