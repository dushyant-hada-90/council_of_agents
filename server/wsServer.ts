import http from "http";
import { parse } from "url";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";
import { verifySessionToken, verifyGuestToken } from "../lib/auth/token";
import { agentRowToConfig } from "../lib/agents/roster";
import { normalizeGoogleVoice } from "../lib/agents/types";
import type { AgentConfig, MeetingConfig } from "../lib/agents/types";
import type { AgentRow, AgentSnapshot, MeetingRow } from "../lib/types/database";
import { roomManager } from "./roomManager";
import { logger } from "./logger";
import { getGuestIpUsageSeconds } from "./audioUsageTracker";

type AuthResult =
  | { kind: "user"; userId: string; username: string }
  | { kind: "guest"; meetingId: string; guestSessionId: string };

async function verifyAnyToken(token: string, meetingId: string): Promise<AuthResult | null> {
  const session = await verifySessionToken(token);
  if (session) {
    return { kind: "user", userId: session.userId, username: session.username };
  }

  const guest = await verifyGuestToken(token);
  if (guest && guest.meetingId === meetingId) {
    return { kind: "guest", meetingId: guest.meetingId, guestSessionId: guest.guestSessionId };
  }

  return null;
}

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function snapshotToConfig(snapshot: AgentSnapshot): AgentConfig {
  return {
    id: snapshot.id,
    name: snapshot.name,
    voice: normalizeGoogleVoice(snapshot.voice),
    roleSummary: snapshot.roleSummary,
    peerProfile: snapshot.description ?? "",
    systemPrompt: snapshot.systemPrompt,
    color: snapshot.color,
  };
}

async function loadAuthMeetingConfig(
  meetingId: string,
  userId: string
): Promise<MeetingConfig | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("*")
    .eq("id", meetingId)
    .eq("user_id", userId)
    .single();

  if (meetingError || !meeting) return null;
  const meetingRow = meeting as MeetingRow;

  if (meetingRow.status === "ended") return null;

  const { data: meetingAgents } = await supabase
    .from("meeting_agents")
    .select("agent_id, sort_order")
    .eq("meeting_id", meetingId)
    .order("sort_order");

  if (!meetingAgents?.length) return null;

  const agentIds = meetingAgents.map((ma: { agent_id: string }) => ma.agent_id);
  const { data: agents } = await supabase
    .from("agents")
    .select("*")
    .in("id", agentIds)
    .eq("user_id", userId);

  if (!agents?.length) return null;

  const sortedAgents = meetingAgents
    .map((ma: { agent_id: string }) => (agents as AgentRow[]).find((a) => a.id === ma.agent_id))
    .filter(Boolean)
    .map((a) => agentRowToConfig(a!));

  const { data: appUser } = await supabase
    .from("app_users")
    .select("display_name, username")
    .eq("id", userId)
    .single();

  const userRow = appUser as { display_name?: string; username?: string } | null;

  return {
    meetingId,
    userId,
    humanName: userRow?.display_name ?? userRow?.username ?? "You",
    topic: meetingRow.topic,
    goal: meetingRow.goal,
    context: meetingRow.context,
    instructions: meetingRow.instructions,
    maxAiTurnsBeforeHuman: meetingRow.max_ai_turns_before_human as 2 | 4 | 6,
    agents: sortedAgents,
    isGuest: false,
  };
}

async function loadGuestMeetingConfig(
  meetingId: string,
  guestSessionId: string
): Promise<MeetingConfig | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: meeting, error } = await supabase
    .from("meetings")
    .select("*")
    .eq("id", meetingId)
    .eq("is_guest", true)
    .eq("guest_session_id", guestSessionId)
    .single();

  if (error || !meeting) return null;
  const meetingRow = meeting as MeetingRow;
  if (meetingRow.status === "ended") return null;

  const snapshots = meetingRow.agents_snapshot ?? [];
  if (!snapshots.length) return null;

  const initialSpokenSeconds = meetingRow.guest_ip
    ? await getGuestIpUsageSeconds(meetingRow.guest_ip)
    : 0;

  return {
    meetingId,
    userId: null,
    humanName: "You",
    topic: meetingRow.topic,
    goal: meetingRow.goal,
    context: meetingRow.context,
    instructions: meetingRow.instructions,
    maxAiTurnsBeforeHuman: meetingRow.max_ai_turns_before_human as 2 | 4 | 6,
    agents: snapshots.map(snapshotToConfig),
    isGuest: true,
    guestSessionId,
    guestIp: meetingRow.guest_ip ?? undefined,
    refinedPrompt: meetingRow.refined_prompt,
    initialSpokenSeconds,
  };
}

export function setupWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = parse(request.url ?? "");
    if (pathname !== "/ws") return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const meetingId = url.searchParams.get("meetingId");
    const token = url.searchParams.get("token");

    if (!meetingId || !token) {
      ws.close(4000, "Missing meetingId or token");
      return;
    }

    if (!roomManager.canAcceptNewMeetings()) {
      ws.close(4003, "Server shutting down");
      return;
    }

    void (async () => {
      const auth = await verifyAnyToken(token, meetingId);
      if (!auth) {
        ws.close(4001, "Unauthorized");
        return;
      }

      let room = roomManager.getRoom(meetingId);

      if (!room) {
        const config =
          auth.kind === "user"
            ? await loadAuthMeetingConfig(meetingId, auth.userId)
            : await loadGuestMeetingConfig(meetingId, auth.guestSessionId);

        if (!config) {
          ws.close(4004, "Meeting not found or ended");
          return;
        }

        try {
          room = roomManager.createRoom(config);
        } catch (err) {
          ws.close(4003, (err as Error).message);
          return;
        }
      } else {
        const roomUserId = room.userId;
        if (auth.kind === "user" && roomUserId !== auth.userId) {
          ws.close(4002, "Forbidden");
          return;
        }
        if (auth.kind === "guest" && (roomUserId !== null || room.config.guestSessionId !== auth.guestSessionId)) {
          ws.close(4002, "Forbidden");
          return;
        }
      }

      if (room.hasClient()) {
        const sameUser =
          auth.kind === "user" &&
          room.userId === auth.userId;
        const sameGuest =
          auth.kind === "guest" &&
          room.config.isGuest &&
          room.config.guestSessionId === auth.guestSessionId;

        if (sameUser || sameGuest) {
          room.evictClient();
        } else {
          ws.close(4001, "Room is occupied");
          return;
        }
      }

      room.attachClient({
        ws,
        userId: auth.kind === "user" ? auth.userId : null,
      });
      logger.info("GATEWAY", `Client joined meeting ${meetingId} (${auth.kind})`);

      ws.on("message", (data, isBinary) => {
        room?.handleMessage(data, isBinary);
      });

      ws.on("close", () => {
        logger.info("GATEWAY", `Client disconnected from meeting ${meetingId}`);
        room?.detachClient();
      });

      ws.on("error", (err) => {
        logger.error("GATEWAY", `WebSocket error: ${err.message}`);
      });
    })();
  });

  return wss;
}
