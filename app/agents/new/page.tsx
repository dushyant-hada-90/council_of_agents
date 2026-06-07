import { AppShell } from "@/components/AppShell";
import { AgentForm } from "@/components/AgentForm";

export default function NewAgentPage() {
  return (
    <AppShell>
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Create agent</h1>
        <AgentForm />
      </div>
    </AppShell>
  );
}
