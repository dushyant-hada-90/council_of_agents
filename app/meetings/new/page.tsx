import { AppShell } from "@/components/AppShell";
import { MeetingConfigForm } from "@/components/MeetingConfigForm";
import { requireUserOrRedirect, getDb } from "@/lib/supabase/server";
import type { AgentRow } from "@/lib/supabase/types";

export default async function NewMeetingPage() {
  const user = await requireUserOrRedirect("/login?redirect=/meetings/new");
  const db = getDb();
  const { data } = await db
    .from("agents")
    .select("*")
    .eq("user_id", user.id)
    .order("name");

  return (
    <AppShell>
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Configure meeting</h1>
        <MeetingConfigForm agents={(data ?? []) as AgentRow[]} />
      </div>
    </AppShell>
  );
}
