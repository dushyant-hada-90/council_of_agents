"use client";

export interface PlannedAgent {
  id: string;
  name: string;
  systemPrompt: string;
  roleSummary: string;
  voice: string;
  color: string;
  description?: string;
}

interface AgentApprovalPanelProps {
  refinedPrompt: string;
  agents: PlannedAgent[];
  onAgentsChange: (agents: PlannedAgent[]) => void;
  onApprove: () => void;
  loading: boolean;
  error: string | null;
}

export function AgentApprovalPanel({
  refinedPrompt,
  agents,
  onAgentsChange,
  onApprove,
  loading,
  error,
}: AgentApprovalPanelProps) {
  function updateAgent(index: number, patch: Partial<PlannedAgent>) {
    const next = agents.map((a, i) => (i === index ? { ...a, ...patch } : a));
    onAgentsChange(next);
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h2 className="text-2xl font-bold mb-2">Your council is ready</h2>
      <p className="text-gray-400 mb-8">{refinedPrompt}</p>

      <p className="text-sm text-gray-500 mb-4">
        Review who will join your discussion. You can edit names and prompts before starting.
      </p>

      <div className="grid gap-4 md:grid-cols-2 mb-8">
        {agents.map((agent, i) => (
          <div
            key={agent.id}
            className="card border-l-4"
            style={{ borderLeftColor: agent.color }}
          >
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Name</label>
                <input
                  value={agent.name}
                  onChange={(e) => updateAgent(i, { name: e.target.value })}
                  className="w-full font-semibold"
                />
              </div>
              {agent.roleSummary && (
                <p className="text-sm text-gray-400">{agent.roleSummary}</p>
              )}
              <div>
                <label className="block text-xs text-gray-500 mb-1">System prompt</label>
                <textarea
                  value={agent.systemPrompt}
                  onChange={(e) => updateAgent(i, { systemPrompt: e.target.value })}
                  rows={4}
                  className="w-full text-sm"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-red-400 mb-4">{error}</p>}

      <button
        type="button"
        onClick={onApprove}
        disabled={loading || agents.some((a) => !a.name.trim() || !a.systemPrompt.trim())}
        className="btn-primary text-lg px-8 py-3 disabled:opacity-50"
      >
        {loading ? "Starting meeting…" : "Approve & start meeting"}
      </button>
    </div>
  );
}
