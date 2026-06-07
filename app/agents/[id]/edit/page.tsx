import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AgentForm } from "@/components/AgentForm";
import { requireUser, getDb } from "@/lib/supabase/server";
import type { AgentRow } from "@/lib/types/database";

type Props = { params: Promise<{ id: string }> };

export default async function EditAgentPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUser();
  const db = getDb();

  const { data } = await db
    .from("agents")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  const agent = data as AgentRow | null;

  if (!agent) notFound();

  return (
    <AppShell>
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Edit {agent.name}</h1>
        <AgentForm agent={agent} />
      </div>
    </AppShell>
  );
}
