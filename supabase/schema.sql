-- =============================================================================
-- Council of Agents — fresh Supabase schema
-- Run once in Supabase SQL Editor (empty public schema)
-- =============================================================================

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
-- app_users — username/password login
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
-- guest_ip_usage — track spoken audio per IP for unauthenticated guests
-- -----------------------------------------------------------------------------
create table if not exists public.guest_ip_usage (
  id uuid primary key default gen_random_uuid(),
  ip_address text not null,
  spoken_audio_seconds numeric not null default 0,
  last_meeting_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_ip_usage_ip_unique unique (ip_address)
);

create index if not exists guest_ip_usage_ip_idx on public.guest_ip_usage (ip_address);

create trigger guest_ip_usage_updated_at
  before update on public.guest_ip_usage
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
  voice text not null default 'en-IN-Wavenet-A',
  provider text not null default 'google',
  model text not null default 'gemini-2.0-flash',
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
-- meetings — voice conference sessions (guest or authenticated)
-- -----------------------------------------------------------------------------
create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.app_users(id) on delete cascade,
  is_guest boolean not null default false,
  guest_session_id text,
  guest_ip text,
  original_prompt text not null default '',
  refined_prompt text not null default '',
  agents_snapshot jsonb,
  topic text not null default '',
  goal text not null default '',
  context text not null default '',
  instructions text not null default '',
  participant_name text,
  max_ai_turns_before_human int not null default 4
    check (max_ai_turns_before_human in (2, 4, 6)),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'active', 'ended', 'cancelled')),
  spoken_audio_seconds numeric not null default 0,
  s3_audio_prefix text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meetings_user_id_idx on public.meetings (user_id);
create index if not exists meetings_status_idx on public.meetings (status);
create index if not exists meetings_guest_session_idx on public.meetings (guest_session_id);
create index if not exists meetings_guest_ip_idx on public.meetings (guest_ip);

create trigger meetings_updated_at
  before update on public.meetings
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- meeting_agents — which saved agents participate (authenticated meetings only)
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
  user_id uuid references public.app_users(id) on delete cascade,
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
-- meeting_audio_segments — S3 audio chunk references
-- -----------------------------------------------------------------------------
create table if not exists public.meeting_audio_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  speaker_type text not null check (speaker_type in ('human', 'agent')),
  speaker_id text not null,
  s3_key text not null,
  duration_seconds numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists meeting_audio_segments_meeting_id_idx
  on public.meeting_audio_segments (meeting_id);

-- -----------------------------------------------------------------------------
-- Row Level Security — service role bypasses; block direct client access
-- -----------------------------------------------------------------------------
alter table public.app_users enable row level security;
alter table public.guest_ip_usage enable row level security;
alter table public.agents enable row level security;
alter table public.meetings enable row level security;
alter table public.meeting_agents enable row level security;
alter table public.transcript_messages enable row level security;
alter table public.meeting_audio_segments enable row level security;

drop policy if exists "No direct app_users access" on public.app_users;
create policy "No direct app_users access"
  on public.app_users for all using (false) with check (false);

drop policy if exists "No direct guest_ip_usage access" on public.guest_ip_usage;
create policy "No direct guest_ip_usage access"
  on public.guest_ip_usage for all using (false) with check (false);

drop policy if exists "No direct agents access" on public.agents;
create policy "No direct agents access"
  on public.agents for all using (false) with check (false);

drop policy if exists "No direct meetings access" on public.meetings;
create policy "No direct meetings access"
  on public.meetings for all using (false) with check (false);

drop policy if exists "No direct meeting_agents access" on public.meeting_agents;
create policy "No direct meeting_agents access"
  on public.meeting_agents for all using (false) with check (false);

drop policy if exists "No direct transcript_messages access" on public.transcript_messages;
create policy "No direct transcript_messages access"
  on public.transcript_messages for all using (false) with check (false);

drop policy if exists "No direct meeting_audio_segments access" on public.meeting_audio_segments;
create policy "No direct meeting_audio_segments access"
  on public.meeting_audio_segments for all using (false) with check (false);
