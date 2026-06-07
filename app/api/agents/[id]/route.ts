import { NextRequest, NextResponse } from "next/server";
import { requireUser, getDb } from "@/lib/supabase/server";
import { normalizeVoice } from "@/lib/agents/types";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const db = getDb();
    const { data, error } = await db
      .from("agents")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (error) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const db = getDb();
    const body = await request.json();

    const { data, error } = await db
      .from("agents")
      .update({
        name: body.name,
        description: body.description,
        system_prompt: body.system_prompt,
        voice: normalizeVoice(body.voice),
        provider: body.provider,
        model: body.model,
        color: body.color,
        role_summary: body.role_summary,
        peer_profile: body.peer_profile,
        metadata: body.metadata,
      })
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const db = getDb();
    const { error } = await db.from("agents").delete().eq("id", id).eq("user_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
