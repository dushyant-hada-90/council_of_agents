import { NextRequest, NextResponse } from "next/server";
import { requireUser, getDb } from "@/lib/supabase/server";
import { normalizeVoice } from "@/lib/agents/types";

export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();
    const { data, error } = await db
      .from("agents")
      .select("*")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const db = getDb();
    const body = await request.json();

    const { data, error } = await db
      .from("agents")
      .insert({
        user_id: user.id,
        name: body.name,
        description: body.description ?? "",
        system_prompt: body.system_prompt,
        voice: normalizeVoice(body.voice),
        provider: body.provider ?? "openai",
        model: body.model ?? "gpt-realtime-2",
        color: body.color ?? "#3b82f6",
        role_summary: body.role_summary ?? body.description ?? "",
        peer_profile: body.peer_profile ?? "",
        metadata: body.metadata ?? {},
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 401 });
  }
}
