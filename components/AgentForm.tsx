"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentRow } from "@/lib/types/database";
import { GOOGLE_TTS_VOICES, normalizeVoice } from "@/lib/agents/types";

interface AgentFormProps {
  agent?: AgentRow;
}

export function AgentForm({ agent }: AgentFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? "");
  const [voice, setVoice] = useState(agent?.voice ?? "en-IN-Wavenet-A");
  const [color, setColor] = useState(agent?.color ?? "#3b82f6");
  const [roleSummary, setRoleSummary] = useState(agent?.role_summary ?? "");
  const [peerProfile, setPeerProfile] = useState(agent?.peer_profile ?? "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const payload = {
      name,
      description,
      system_prompt: systemPrompt,
      voice: normalizeVoice(voice),
      color,
      role_summary: roleSummary,
      peer_profile: peerProfile,
    };

    const url = agent ? `/api/agents/${agent.id}` : "/api/agents";
    const method = agent ? "PUT" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to save");
      setLoading(false);
      return;
    }

    router.push("/agents");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4 max-w-2xl">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Color</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-full h-10" />
        </div>
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full" />
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Role summary</label>
        <input value={roleSummary} onChange={(e) => setRoleSummary(e.target.value)} className="w-full" />
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Peer profile</label>
        <textarea
          value={peerProfile}
          onChange={(e) => setPeerProfile(e.target.value)}
          rows={2}
          className="w-full"
        />
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Personality / System prompt</label>
        <textarea
          required
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={8}
          className="w-full font-mono text-sm"
        />
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Voice (Google Cloud TTS)</label>
        <select value={voice} onChange={(e) => setVoice(e.target.value)} className="w-full">
          {GOOGLE_TTS_VOICES.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="flex gap-3">
        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? "Saving…" : agent ? "Update agent" : "Create agent"}
        </button>
        <button type="button" onClick={() => router.back()} className="btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
