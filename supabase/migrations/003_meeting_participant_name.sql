-- Track the human participant's display name for each meeting (guest or authenticated).
alter table public.meetings
  add column if not exists participant_name text;

comment on column public.meetings.participant_name is
  'Display name of the human in this meeting; used in transcripts and Gemini prompts.';
