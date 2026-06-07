import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { AgentActions } from "@/components/AgentActions";
import { requireUser, getDb } from "@/lib/supabase/server";
import type { AgentRow } from "@/lib/types/database";

export default async function AgentsPage() {
  const user = await requireUser();
  const db = getDb();
  const { data } = await db
    .from("agents")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  const agents = (data ?? []) as AgentRow[];

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold">Agents</h1>
          <Link href="/agents/new" className="btn-primary">Create agent</Link>
        </div>

        {!agents.length ? (
          <div className="card text-center py-12">
            <p className="text-gray-400 mb-4">No agents yet. Create your first AI advisor.</p>
            <Link href="/agents/new" className="btn-primary">Create agent</Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((a) => (
              <div key={a.id} className="card">
                <div className="flex items-start justify-between mb-2">
                  <h2 className="font-semibold text-lg" style={{ color: a.color }}>{a.name}</h2>
                  <span className="text-xs text-gray-500">{a.voice}</span>
                </div>
                <p className="text-sm text-gray-400 mb-4 line-clamp-2">{a.description || a.role_summary}</p>
                <div className="flex gap-2 flex-wrap items-center">
                  <Link href={`/agents/${a.id}/edit`} className="btn-secondary text-sm py-1">Edit</Link>
                  <AgentActions agentId={a.id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
