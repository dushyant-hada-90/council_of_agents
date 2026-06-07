import { NextRequest, NextResponse } from "next/server";
import { requireUser, getDb } from "@/lib/supabase/server";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const db = getDb();

    const { data: source, error: fetchError } = await db
      .from("agents")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (fetchError || !source) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { data, error } = await db
      .from("agents")
      .insert({
        user_id: user.id,
        name: `${source.name} (copy)`,
        description: source.description,
        system_prompt: source.system_prompt,
        voice: source.voice,
        provider: source.provider,
        model: source.model,
        color: source.color,
        role_summary: source.role_summary,
        peer_profile: source.peer_profile,
        metadata: source.metadata,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
