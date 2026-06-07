import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { requireUser, getDb } from "@/lib/supabase/server";

export default async function MeetingsPage() {
  const user = await requireUser();
  const db = getDb();
  const { data: meetings } = await db
    .from("meetings")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold">Meetings</h1>
          <Link href="/meetings/new" className="btn-primary">New meeting</Link>
        </div>

        {!meetings?.length ? (
          <div className="card text-center py-12">
            <p className="text-gray-400">No meetings yet.</p>
          </div>
        ) : (
          <div className="card divide-y divide-surface-border">
            {meetings.map((m) => (
              <div key={m.id} className="py-4 flex justify-between items-center">
                <div>
                  <p className="font-medium">{m.topic || "Untitled"}</p>
                  <p className="text-sm text-gray-500">
                    {new Date(m.created_at).toLocaleString()} · {m.status} ·
                    max {m.max_ai_turns_before_human} AI turns
                  </p>
                </div>
                <div className="flex gap-2">
                  {m.status !== "ended" && (
                    <Link href={`/meetings/${m.id}`} className="btn-primary text-sm py-1">Join</Link>
                  )}
                  <Link href={`/meetings/${m.id}/transcript`} className="btn-secondary text-sm py-1">
                    Transcript
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
