import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { GuestMeetingShell } from "@/components/GuestMeetingShell";
import { TranscriptViewer } from "@/components/TranscriptViewer";
import { getUser, getDb } from "@/lib/supabase/server";
import {
  GUEST_SESSION_COOKIE,
  verifyGuestToken,
} from "@/lib/auth/token";
import type { MeetingRow, TranscriptMessageRow } from "@/lib/supabase/types";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ guest?: string }>;
};

export default async function TranscriptPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { guest: guestTokenParam } = await searchParams;
  const db = getDb();

  let meeting: MeetingRow | null = null;
  let messages: TranscriptMessageRow[] = [];
  let isGuestView = false;

  const user = await getUser();
  if (user) {
    const { data } = await db
      .from("meetings")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (data) {
      meeting = data as MeetingRow;
      const { data: rows } = await db
        .from("transcript_messages")
        .select("*")
        .eq("meeting_id", id)
        .order("message_timestamp", { ascending: true });
      messages = (rows ?? []) as TranscriptMessageRow[];
    }
  }

  if (!meeting) {
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
        const { data } = await db
          .from("meetings")
          .select("*")
          .eq("id", id)
          .eq("is_guest", true)
          .eq("guest_session_id", guestSessionId)
          .single();

        if (data) {
          meeting = data as MeetingRow;
          isGuestView = true;
          const { data: rows } = await db
            .from("transcript_messages")
            .select("*")
            .eq("meeting_id", id)
            .order("message_timestamp", { ascending: true });
          messages = (rows ?? []) as TranscriptMessageRow[];
        }
      }
    }
  }

  if (!meeting) {
    if (!user) {
      redirect(`/login?redirect=${encodeURIComponent(`/meetings/${id}/transcript`)}`);
    }
    notFound();
  }

  const content = (
    <div className="space-y-6">
      <div>
        {!isGuestView && (
          <Link href="/meetings" className="text-accent text-sm">
            ← Meetings
          </Link>
        )}
        {isGuestView && (
          <Link href="/" className="text-accent text-sm">
            ← Home
          </Link>
        )}
        <h1 className="text-3xl font-bold mt-2">{meeting.topic || "Transcript"}</h1>
        <p className="text-gray-400 text-sm">
          {meeting.status} · {messages.length} messages
        </p>
      </div>
      <TranscriptViewer meetingId={id} messages={messages} />
    </div>
  );

  if (isGuestView) {
    return (
      <GuestMeetingShell topic={meeting.topic ?? "Meeting transcript"}>
        {content}
      </GuestMeetingShell>
    );
  }

  return <AppShell>{content}</AppShell>;
}
