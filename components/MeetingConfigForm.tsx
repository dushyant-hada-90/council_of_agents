"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentRow } from "@/lib/supabase/types";

interface MeetingConfigFormProps {
  agents: AgentRow[];
}

export function MeetingConfigForm({ agents }: MeetingConfigFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [instructions, setInstructions] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());

  function toggleAgent(id: string) {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedAgents.size < 1) {
      setError("Select at least one agent");
      return;
    }
    setLoading(true);
    setError(null);

    const res = await fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        goal,
        context,
        instructions,
        agent_ids: [...selectedAgents],
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to create meeting");
      setLoading(false);
      return;
    }

    const meeting = await res.json();
    router.push(`/meetings/${meeting.id}`);
  }

  if (agents.length === 0) {
    return (
      <div className="card">
        <p className="text-gray-400">Create at least one agent before starting a meeting.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      <div className="card space-y-4">
        <h2 className="font-semibold">Meeting details</h2>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Topic</label>
          <input required value={topic} onChange={(e) => setTopic(e.target.value)} className="w-full" />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Goal</label>
          <input value={goal} onChange={(e) => setGoal(e.target.value)} className="w-full" />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Context</label>
          <textarea value={context} onChange={(e) => setContext(e.target.value)} rows={3} className="w-full" />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Optional instructions</label>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} className="w-full" />
        </div>
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold">Select agents ({selectedAgents.size} selected)</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {agents.map((a) => (
            <label
              key={a.id}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${
                selectedAgents.has(a.id) ? "border-accent bg-accent-muted/30" : "border-surface-border"
              }`}
            >
              <input
                type="checkbox"
                checked={selectedAgents.has(a.id)}
                onChange={() => toggleAgent(a.id)}
              />
              <span style={{ color: a.color }} className="font-medium">{a.name}</span>
              <span className="text-xs text-gray-500 truncate">{a.description || a.role_summary}</span>
            </label>
          ))}
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button type="submit" disabled={loading} className="btn-primary">
        {loading ? "Creating…" : "Start meeting"}
      </button>
    </form>
  );
}
