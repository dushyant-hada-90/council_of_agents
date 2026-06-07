import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { requireUser, getDb } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const user = await requireUser();
  const db = getDb();

  const [agentsRes, meetingsRes, transcriptCountRes] = await Promise.all([
    db.from("agents").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    db.from("meetings").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(5),
    db.from("transcript_messages").select("id", { count: "exact", head: true }).eq("user_id", user.id),
  ]);

  const meetings = meetingsRes.data ?? [];
  const ended = meetings.filter((m) => m.status === "ended" && m.started_at && m.ended_at);
  const totalMinutes = ended.reduce((sum, m) => {
    return sum + (new Date(m.ended_at!).getTime() - new Date(m.started_at!).getTime()) / 60000;
  }, 0);

  const stats = [
    { label: "Agents", value: agentsRes.count ?? 0 },
    { label: "Meetings", value: meetings.length },
    { label: "Transcript messages", value: transcriptCountRes.count ?? 0 },
    { label: "Conversation time (min)", value: Math.round(totalMinutes) },
  ];

  return (
    <AppShell>
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-bold">
            Welcome{user.display_name ? `, ${user.display_name}` : user.username ? `, ${user.username}` : ""}
          </h1>
          <p className="text-gray-400 mt-1">Your multi-agent voice conference dashboard</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stats.map((s) => (
            <div key={s.label} className="card text-center">
              <p className="text-3xl font-bold text-accent">{s.value}</p>
              <p className="text-sm text-gray-400 mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <Link href="/agents/new" className="btn-primary">Create agent</Link>
          <Link href="/meetings/new" className="btn-secondary">New meeting</Link>
        </div>

        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold">Recent meetings</h2>
            <Link href="/meetings" className="text-accent text-sm">View all</Link>
          </div>
          {meetings.length === 0 ? (
            <p className="text-gray-500 text-sm">No meetings yet.</p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {meetings.map((m) => (
                <li key={m.id} className="py-3 flex justify-between items-center">
                  <div>
                    <p className="font-medium">{m.topic || "Untitled meeting"}</p>
                    <p className="text-xs text-gray-500">{new Date(m.created_at).toLocaleString()} · {m.status}</p>
                  </div>
                  <div className="flex gap-2">
                    {m.status !== "ended" && (
                      <Link href={`/meetings/${m.id}`} className="btn-primary text-sm py-1">Join</Link>
                    )}
                    <Link href={`/meetings/${m.id}/transcript`} className="btn-secondary text-sm py-1">Transcript</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}
