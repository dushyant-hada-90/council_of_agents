export type SpeakerType = "human" | "agent";
export type MeetingStatus = "scheduled" | "active" | "ended" | "cancelled";
export type MaxAiTurnsBeforeHuman = 2 | 4 | 6;
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Profile {
  id: string;
  display_name: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
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
  user_id: string;
  topic: string;
  goal: string;
  context: string;
  instructions: string;
  max_ai_turns_before_human: MaxAiTurnsBeforeHuman;
  status: MeetingStatus;
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
  user_id: string;
  speaker_id: string;
  speaker_name: string;
  speaker_type: SpeakerType;
  message: string;
  message_timestamp: string;
  partial: boolean;
  metadata: Json;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: {
          id: string;
          display_name?: string | null;
          email?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Profile>;
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
          user_id: string;
          topic?: string;
          goal?: string;
          context?: string;
          instructions?: string;
          max_ai_turns_before_human?: MaxAiTurnsBeforeHuman;
          status?: MeetingStatus;
          started_at?: string | null;
          ended_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<MeetingRow, "id" | "user_id">>;
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
          user_id: string;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
