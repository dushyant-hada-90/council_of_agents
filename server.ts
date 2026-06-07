import "dotenv/config";
import next from "next";
import http from "http";
import { setupWebSocketServer } from "./server/wsServer";
import { roomManager } from "./server/roomManager";
import { flushAllTranscripts } from "./server/transcriptPersister";
import { logger } from "./server/logger";
import { getEnv } from "./lib/env";

const dev = process.env.NODE_ENV !== "production";
const env = getEnv();
const port = env.PORT;
const hostname = "0.0.0.0";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("SYSTEM", `Received ${signal} — graceful shutdown starting`);

  // 1. Stop accepting new meetings
  roomManager.setAcceptingNewMeetings(false);

  // 2. Flush pending transcripts
  await flushAllTranscripts();

  // 3. Persist session data & close active connections
  await roomManager.destroyAll();

  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    if (shuttingDown && !req.url?.startsWith("/api/health")) {
      res.statusCode = 503;
      res.setHeader("Retry-After", "30");
      res.end("Server shutting down");
      return;
    }
    void handle(req, res);
  });

  setupWebSocketServer(server);

  server.listen(port, hostname, () => {
    logger.info("SYSTEM", `Council of Agents running at http://${hostname}:${port}`);
    logger.info("SYSTEM", `WebSocket endpoint: ws://${hostname}:${port}/ws`);
  });

  server.on("error", (err) => {
    logger.error("SYSTEM", `HTTP server error: ${err.message}`);
    process.exit(1);
  });
});
