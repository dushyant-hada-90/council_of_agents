"use client";

import { useMemo, useState } from "react";
import type { TranscriptMessageRow } from "@/lib/types/database";

export function TranscriptViewer({
  meetingId,
  messages,
}: {
  meetingId: string;
  messages: TranscriptMessageRow[];
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(
    () =>
      messages.filter(
        (m) =>
          m.message.toLowerCase().includes(search.toLowerCase()) ||
          m.speaker_name.toLowerCase().includes(search.toLowerCase())
      ),
    [messages, search]
  );

  function download() {
    const text = messages
      .map(
        (m) =>
          `[${new Date(m.message_timestamp).toISOString()}] ${m.speaker_name}: ${m.message}`
      )
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transcript-${meetingId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="flex gap-4 items-center">
        <input
          type="search"
          placeholder="Search transcript…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 max-w-md"
        />
        <button onClick={download} disabled={!messages.length} className="btn-secondary">
          Download
        </button>
      </div>

      <div className="card max-h-[70vh] overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-gray-500">No transcript messages yet.</p>
        ) : (
          <div className="space-y-3">
            {filtered.map((m) => (
              <div key={m.id} className="text-sm border-b border-surface-border pb-2">
                <div className="flex gap-2 text-xs text-gray-500 mb-1">
                  <span className="font-medium text-gray-300">{m.speaker_name}</span>
                  <span>{new Date(m.message_timestamp).toLocaleString()}</span>
                  <span className="capitalize">{m.speaker_type}</span>
                </div>
                <p>{m.message}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
