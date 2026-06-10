"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SUGGESTED_PROMPTS } from "@/lib/config/suggestedPrompts";
import { AgentPlanningLoader } from "./AgentPlanningLoader";
import {
  AgentApprovalPanel,
  type PlannedAgent,
} from "./AgentApprovalPanel";

interface PromptLandingProps {
  isLoggedIn?: boolean;
}

type Step = "prompt" | "loading" | "approval";

export function PromptLanding({ isLoggedIn }: PromptLandingProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("prompt");
  const [prompt, setPrompt] = useState("");
  const [refinedPrompt, setRefinedPrompt] = useState("");
  const [meetingMeta, setMeetingMeta] = useState({
    topic: "",
    goal: "",
    context: "",
    instructions: "",
  });
  const [agents, setAgents] = useState<PlannedAgent[]>([]);
  const [participantName, setParticipantName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (step !== "loading" && step !== "approval") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [step]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (trimmed.length < 10) {
      setError("Please write at least 10 characters about what you'd like to discuss.");
      return;
    }

    setError(null);
    setStep("loading");

    try {
      const res = await fetch("/api/guest/plan-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmed }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to plan advisors");
        setStep("prompt");
        return;
      }

      setRefinedPrompt(data.refinedPrompt);
      setMeetingMeta({
        topic: data.topic,
        goal: data.goal,
        context: data.context,
        instructions: data.instructions,
      });
      setAgents(data.agents);
      setStep("approval");
    } catch {
      setError("Something went wrong. Please try again.");
      setStep("prompt");
    }
  }

  async function handleApprove() {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/guest/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalPrompt: prompt.trim(),
          refinedPrompt,
          participantName: participantName.trim(),
          ...meetingMeta,
          agents: agents.map((a) => ({
            id: a.id,
            name: a.name,
            systemPrompt: a.systemPrompt,
            roleSummary: a.roleSummary,
            voice: a.voice,
            color: a.color,
            description: a.description ?? a.roleSummary,
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create meeting");
        setSubmitting(false);
        return;
      }

      router.push(`/meetings/${data.meetingId}?guest=${encodeURIComponent(data.guestToken)}`);
    } catch {
      setError("Failed to start meeting.");
      setSubmitting(false);
    }
  }

  if (step === "loading") {
    return <AgentPlanningLoader prompt={prompt.trim()} />;
  }

  if (step === "approval") {
    return (
      <AgentApprovalPanel
        refinedPrompt={refinedPrompt}
        participantName={participantName}
        onParticipantNameChange={setParticipantName}
        agents={agents}
        onAgentsChange={setAgents}
        onApprove={handleApprove}
        loading={submitting}
        error={error}
      />
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="text-center mb-10">
        <h1 className="text-4xl md:text-5xl font-bold mb-4">
          What would you like to discuss?
        </h1>
        <p className="text-gray-400">
          Describe your topic and we&apos;ll assemble a council of AI advisors for a live voice meeting.
        </p>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. I'm considering leaving my job to start a SaaS company. I want advisors to help me think through the risks and opportunities…"
          rows={5}
          className="w-full text-lg"
        />

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button type="submit" className="btn-primary w-full text-lg py-3">
          Start planning
        </button>
      </form>

      <div className="mt-10">
        <p className="text-sm text-gray-500 mb-3">Suggested prompts</p>
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_PROMPTS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setPrompt(s)}
              className="text-sm px-3 py-1.5 rounded-full bg-surface-border hover:bg-gray-700 text-gray-300 transition"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {isLoggedIn && (
        <p className="text-center mt-8 text-sm text-gray-500">
          <Link href="/dashboard" className="text-accent hover:underline">
            Go to dashboard
          </Link>
          {" "}to manage saved agents and meetings.
        </p>
      )}
    </div>
  );
}
