"use client";

import { useRouter } from "next/navigation";

export function AgentActions({ agentId }: { agentId: string }) {
  const router = useRouter();

  async function duplicate() {
    await fetch(`/api/agents/${agentId}/duplicate`, { method: "POST" });
    router.refresh();
  }

  async function remove() {
    if (!confirm("Delete this agent?")) return;
    await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="flex gap-2 flex-wrap">
      <button onClick={duplicate} className="btn-secondary text-sm py-1">Duplicate</button>
      <button onClick={remove} className="btn-secondary text-sm py-1 text-red-400">Delete</button>
    </div>
  );
}
