import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { MeetingRoom } from "@/components/MeetingRoom";
import { GuestMeetingShell } from "@/components/GuestMeetingShell";
import { requireUser, getDb } from "@/lib/supabase/server";
import {
  GUEST_SESSION_COOKIE,
  verifyGuestToken,
} from "@/lib/auth/token";
import { GUEST_LIMITS } from "@/lib/config/guestLimits";

type MeetingAgentCard = {
  id: string;
  name: string;
  voice: string;
  color: string;
};

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ guest?: string }>;
};

export default async function MeetingPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { guest: guestTokenParam } = await searchParams;
  const db = getDb();

  const user = await (async () => {
    try {
      return await requireUser();
    } catch {
      return null;
    }
  })();

  if (user) {
    const { data: meeting } = await db
      .from("meetings")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (meeting) {
      const { data: meetingAgents } = await db
        .from("meeting_agents")
        .select("agent_id, sort_order")
        .eq("meeting_id", id)
        .order("sort_order");

      const agentIds = (meetingAgents ?? []).map(
        (row: { agent_id: string }) => row.agent_id
      );

      let initialAgents: MeetingAgentCard[] = [];
      if (agentIds.length > 0) {
        const { data: agents } = await db
          .from("agents")
          .select("id, name, voice, color")
          .in("id", agentIds)
          .eq("user_id", user.id);

        const byId = new Map(
          ((agents ?? []) as MeetingAgentCard[]).map((a) => [a.id, a])
        );
        initialAgents = agentIds
          .map((agentId) => byId.get(agentId))
          .filter((a): a is MeetingAgentCard => Boolean(a));
      }

      return (
        <AppShell>
          <MeetingRoom
            meetingId={id}
            humanName={user.display_name ?? user.username ?? "You"}
            initialAgents={initialAgents}
            isGuest={false}
          />
        </AppShell>
      );
    }
  }

  const cookieStore = await cookies();
  const guestSessionId = cookieStore.get(GUEST_SESSION_COOKIE)?.value;
  const guestToken = guestTokenParam ?? null;

  if (guestToken && guestSessionId) {
    const payload = await verifyGuestToken(guestToken);
    if (
      payload &&
      payload.meetingId === id &&
      payload.guestSessionId === guestSessionId
    ) {
      const { data: meeting } = await db
        .from("meetings")
        .select("*")
        .eq("id", id)
        .eq("is_guest", true)
        .eq("guest_session_id", guestSessionId)
        .single();

      if (meeting) {
        const row = meeting as {
          refined_prompt?: string;
          topic?: string;
          participant_name?: string | null;
          agents_snapshot?: Array<{
            id: string;
            name: string;
            voice: string;
            color: string;
          }>;
        };
        const initialAgents: MeetingAgentCard[] = (row.agents_snapshot ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          voice: a.voice,
          color: a.color,
        }));

        return (
          <GuestMeetingShell topic={row.topic ?? row.refined_prompt ?? "Guest meeting"}>
            <MeetingRoom
              meetingId={id}
              humanName={row.participant_name?.trim() || "You"}
              initialAgents={initialAgents}
              isGuest
              guestToken={guestToken}
              refinedPrompt={row.refined_prompt}
              audioLimits={GUEST_LIMITS}
            />
          </GuestMeetingShell>
        );
      }
    }
  }

  notFound();
}
