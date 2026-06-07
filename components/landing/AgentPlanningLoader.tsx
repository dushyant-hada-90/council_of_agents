"use client";

interface AgentPlanningLoaderProps {
  prompt: string;
}

export function AgentPlanningLoader({ prompt }: AgentPlanningLoaderProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin mb-6" />
      <h2 className="text-xl font-semibold mb-2">Assembling your council…</h2>
      <p className="text-gray-400 max-w-md mb-4">
        Our AI is refining your agenda and selecting advisors who can help you discuss:
      </p>
      <p className="text-gray-300 italic max-w-lg">&ldquo;{prompt}&rdquo;</p>
    </div>
  );
}
