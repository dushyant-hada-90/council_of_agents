import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { MeetingRoom } from "@/components/MeetingRoom";
import { requireUser, getDb } from "@/lib/supabase/server";

type Props = { params: Promise<{ id: string }> };

export default async function MeetingPage({ params }: Props) {
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

  return (
    <AppShell>
      <MeetingRoom
        meetingId={id}
        humanName={user.display_name ?? user.username ?? "You"}
      />
    </AppShell>
  );
}
