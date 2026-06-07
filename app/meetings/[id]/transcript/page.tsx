import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { TranscriptViewer } from "@/components/TranscriptViewer";
import { requireUser, getDb } from "@/lib/supabase/server";
import { notFound } from "next/navigation";

type Props = { params: Promise<{ id: string }> };

export default async function TranscriptPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUser();
  const db = getDb();

  const { data: meeting } = await db
    .from("meetings")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!meeting) notFound();

  const { data: messages } = await db
    .from("transcript_messages")
    .select("*")
    .eq("meeting_id", id)
    .order("message_timestamp", { ascending: true });

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <Link href="/meetings" className="text-accent text-sm">← Meetings</Link>
          <h1 className="text-3xl font-bold mt-2">{meeting.topic || "Transcript"}</h1>
          <p className="text-gray-400 text-sm">
            {meeting.status} · {(messages ?? []).length} messages
          </p>
        </div>
        <TranscriptViewer meetingId={id} messages={messages ?? []} />
      </div>
    </AppShell>
  );
}
