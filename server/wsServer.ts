import http from "http";
import { parse } from "url";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";
import { verifySessionToken } from "../lib/auth/token";
import { agentRowToConfig } from "../lib/agents/roster";
import type { MeetingConfig } from "../lib/agents/types";
import type { AgentRow, MeetingRow } from "../lib/types/database";
import { roomManager } from "./roomManager";
import { logger } from "./logger";
import { getEnv } from "../lib/env";

async function verifyToken(token: string): Promise<{ userId: string; username: string } | null> {
  return verifySessionToken(token);
}

async function loadMeetingConfig(
  meetingId: string,
  userId: string
): Promise<MeetingConfig | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const supabase = createClient(url, key);

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
  };
}

export function setupWebSocketServer(server: http.Server): WebSocketServer {
  // noServer: true — only handle /ws upgrades so Next.js HMR (/_next/webpack-hmr) still works
  const wss = new WebSocketServer({ noServer: true });
  const apiKey = getEnv().OPENAI_API_KEY;

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
      const auth = await verifyToken(token);
      if (!auth) {
        ws.close(4001, "Unauthorized");
        return;
      }

      let room = roomManager.getRoom(meetingId);
      if (!room) {
        const config = await loadMeetingConfig(meetingId, auth.userId);
        if (!config) {
          ws.close(4004, "Meeting not found or ended");
          return;
        }
        try {
          room = roomManager.createRoom(config, apiKey);
        } catch (err) {
          ws.close(4003, (err as Error).message);
          return;
        }
      } else if (room.userId !== auth.userId) {
        ws.close(4002, "Forbidden");
        return;
      }

      if (room.hasClient()) {
        ws.close(4001, "Room is occupied");
        return;
      }

      room.attachClient({ ws, userId: auth.userId });
      logger.info("GATEWAY", `Client joined meeting ${meetingId}`);

      ws.on("message", (data, isBinary) => {
        room?.handleMessage(data, isBinary);
      });

      ws.on("close", () => {
        logger.info("GATEWAY", `Client disconnected from meeting ${meetingId} (room kept alive)`);
        room?.detachClient();
      });

      ws.on("error", (err) => {
        logger.error("GATEWAY", `WebSocket error: ${err.message}`);
      });
    })();
  });

  return wss;
}
