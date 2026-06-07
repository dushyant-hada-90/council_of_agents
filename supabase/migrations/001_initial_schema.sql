-- Council of Agents — initial schema with RLS

-- Profiles (extends auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Agents
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text default '',
  system_prompt text not null,
  voice text not null default 'alloy',
  provider text not null default 'openai',
  model text not null default 'gpt-realtime-2',
  color text not null default '#3b82f6',
  role_summary text default '',
  peer_profile text default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agents_user_id_idx on public.agents(user_id);

-- Meetings
create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  topic text not null default '',
  goal text default '',
  context text default '',
  instructions text default '',
  max_ai_turns_before_human int not null default 4 check (max_ai_turns_before_human in (2, 4, 6)),
  status text not null default 'scheduled' check (status in ('scheduled', 'active', 'ended', 'cancelled')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meetings_user_id_idx on public.meetings(user_id);
create index if not exists meetings_status_idx on public.meetings(status);

-- Meeting ↔ Agent junction
create table if not exists public.meeting_agents (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  sort_order int not null default 0,
  unique(meeting_id, agent_id)
);

create index if not exists meeting_agents_meeting_id_idx on public.meeting_agents(meeting_id);

-- Transcript messages
create table if not exists public.transcript_messages (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  speaker_id text not null,
  speaker_name text not null,
  speaker_type text not null check (speaker_type in ('human', 'agent')),
  message text not null,
  message_timestamp timestamptz not null default now(),
  partial boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists transcript_messages_meeting_id_idx on public.transcript_messages(meeting_id);
create index if not exists transcript_messages_user_id_idx on public.transcript_messages(user_id);
create index if not exists transcript_messages_timestamp_idx on public.transcript_messages(meeting_id, message_timestamp);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger agents_updated_at before update on public.agents
  for each row execute function public.set_updated_at();
create trigger meetings_updated_at before update on public.meetings
  for each row execute function public.set_updated_at();

-- RLS
alter table public.profiles enable row level security;
alter table public.agents enable row level security;
alter table public.meetings enable row level security;
alter table public.meeting_agents enable row level security;
alter table public.transcript_messages enable row level security;

-- Profiles policies
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

-- Agents policies
create policy "Users can view own agents"
  on public.agents for select using (auth.uid() = user_id);
create policy "Users can insert own agents"
  on public.agents for insert with check (auth.uid() = user_id);
create policy "Users can update own agents"
  on public.agents for update using (auth.uid() = user_id);
create policy "Users can delete own agents"
  on public.agents for delete using (auth.uid() = user_id);

-- Meetings policies
create policy "Users can view own meetings"
  on public.meetings for select using (auth.uid() = user_id);
create policy "Users can insert own meetings"
  on public.meetings for insert with check (auth.uid() = user_id);
create policy "Users can update own meetings"
  on public.meetings for update using (auth.uid() = user_id);
create policy "Users can delete own meetings"
  on public.meetings for delete using (auth.uid() = user_id);

-- Meeting agents policies (via meeting ownership)
create policy "Users can view own meeting agents"
  on public.meeting_agents for select
  using (exists (
    select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()
  ));
create policy "Users can insert own meeting agents"
  on public.meeting_agents for insert
  with check (exists (
    select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()
  ));
create policy "Users can delete own meeting agents"
  on public.meeting_agents for delete
  using (exists (
    select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()
  ));

-- Transcript policies
create policy "Users can view own transcripts"
  on public.transcript_messages for select using (auth.uid() = user_id);
create policy "Users can insert own transcripts"
  on public.transcript_messages for insert with check (auth.uid() = user_id);
