export type SpeakerType = "human" | "agent";
export type MeetingStatus = "scheduled" | "active" | "ended" | "cancelled";
export type MaxAiTurnsBeforeHuman = 2 | 4 | 6;
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface AppUserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface GuestIpUsageRow {
  id: string;
  ip_address: string;
  spoken_audio_seconds: number;
  last_meeting_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  systemPrompt: string;
  voice: string;
  color: string;
  roleSummary: string;
  description?: string;
}

export interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  system_prompt: string;
  voice: string;
  provider: string;
  model: string;
  color: string;
  role_summary: string;
  peer_profile: string;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface MeetingRow {
  id: string;
  user_id: string | null;
  is_guest: boolean;
  guest_session_id: string | null;
  guest_ip: string | null;
  original_prompt: string;
  refined_prompt: string;
  agents_snapshot: AgentSnapshot[] | null;
  topic: string;
  goal: string;
  context: string;
  instructions: string;
  max_ai_turns_before_human: MaxAiTurnsBeforeHuman;
  status: MeetingStatus;
  spoken_audio_seconds: number;
  s3_audio_prefix: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MeetingAgentRow {
  id: string;
  meeting_id: string;
  agent_id: string;
  sort_order: number;
}

export interface TranscriptMessageRow {
  id: string;
  meeting_id: string;
  user_id: string | null;
  speaker_id: string;
  speaker_name: string;
  speaker_type: SpeakerType;
  message: string;
  message_timestamp: string;
  partial: boolean;
  metadata: Json;
  created_at: string;
}

export interface MeetingAudioSegmentRow {
  id: string;
  meeting_id: string;
  speaker_type: SpeakerType;
  speaker_id: string;
  s3_key: string;
  duration_seconds: number;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      app_users: {
        Row: AppUserRow;
        Insert: {
          id?: string;
          username: string;
          password_hash: string;
          display_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<AppUserRow, "id">>;
        Relationships: [];
      };
      guest_ip_usage: {
        Row: GuestIpUsageRow;
        Insert: {
          id?: string;
          ip_address: string;
          spoken_audio_seconds?: number;
          last_meeting_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<GuestIpUsageRow, "id">>;
        Relationships: [];
      };
      agents: {
        Row: AgentRow;
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          description?: string;
          system_prompt: string;
          voice?: string;
          provider?: string;
          model?: string;
          color?: string;
          role_summary?: string;
          peer_profile?: string;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<AgentRow, "id" | "user_id">>;
        Relationships: [];
      };
      meetings: {
        Row: MeetingRow;
        Insert: {
          id?: string;
          user_id?: string | null;
          is_guest?: boolean;
          guest_session_id?: string | null;
          guest_ip?: string | null;
          original_prompt?: string;
          refined_prompt?: string;
          agents_snapshot?: AgentSnapshot[] | null;
          topic?: string;
          goal?: string;
          context?: string;
          instructions?: string;
          max_ai_turns_before_human?: MaxAiTurnsBeforeHuman;
          status?: MeetingStatus;
          spoken_audio_seconds?: number;
          s3_audio_prefix?: string | null;
          started_at?: string | null;
          ended_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<MeetingRow, "id">>;
        Relationships: [];
      };
      meeting_agents: {
        Row: MeetingAgentRow;
        Insert: {
          id?: string;
          meeting_id: string;
          agent_id: string;
          sort_order?: number;
        };
        Update: Partial<Omit<MeetingAgentRow, "id">>;
        Relationships: [];
      };
      transcript_messages: {
        Row: TranscriptMessageRow;
        Insert: {
          id?: string;
          meeting_id: string;
          user_id?: string | null;
          speaker_id: string;
          speaker_name: string;
          speaker_type: SpeakerType;
          message: string;
          message_timestamp?: string;
          partial?: boolean;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<Omit<TranscriptMessageRow, "id">>;
        Relationships: [];
      };
      meeting_audio_segments: {
        Row: MeetingAudioSegmentRow;
        Insert: {
          id?: string;
          meeting_id: string;
          speaker_type: SpeakerType;
          speaker_id: string;
          s3_key: string;
          duration_seconds?: number;
          created_at?: string;
        };
        Update: Partial<Omit<MeetingAudioSegmentRow, "id">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
