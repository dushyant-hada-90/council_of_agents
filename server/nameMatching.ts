/**
 * Normalize agent first-name tokens for routing (STT spelling variants).
 * Only applies safe canonical mappings — not blind trailing-h stripping (Rohan ≠ Roan).
 */
const CANONICAL_STRIP_H = new Set(["sara", "sarah", "sarahh", "sera", "farah"]);

export function normalizeAgentNameToken(token: string): string {
  const t = token.toLowerCase().trim();
  const map: Record<string, string> = {
    sarah: "sara",
    sarahh: "sara",
    sera: "sara",
    farah: "sara",
    rohaan: "rohan",
    vikrum: "vikram",
    preeya: "priya",
    priyah: "priya",
    anica: "anika",
    anneka: "anika",
  };
  if (map[t]) return map[t];
  if (CANONICAL_STRIP_H.has(t)) return "sara";
  if (t.endsWith("h") && t.length > 3) {
    const stripped = t.slice(0, -1);
    if (stripped === "sara") return "sara";
  }
  return t;
}

export function agentNamesMatch(heard: string, canonicalName: string): boolean {
  const canonical = canonicalName.toLowerCase();
  const h = normalizeAgentNameToken(heard);
  const c = normalizeAgentNameToken(canonical);
  return h === c;
}

export function findAgentByNameToken(
  token: string,
  candidates: Array<{ id: string; name: string }>
): { id: string; name: string } | undefined {
  return candidates.find((c) => agentNamesMatch(token, c.name));
}
