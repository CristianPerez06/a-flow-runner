import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientCommand, ServerEvent } from "@a-flow-runner/shared";
import { RunnerSession } from "./runner.js";
import { RecorderSession } from "./recorder.js";

const PORT = Number(process.env.PORT ?? 4319);
const __dirname = dirname(fileURLToPath(import.meta.url));
// Built web bundle lives at web/dist; served in production. In dev, Vite serves the UI.
const WEB_DIST = join(__dirname, "..", "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const clients = new Set<WebSocket>();

function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

const session = new RunnerSession(broadcast);
const recorder = new RecorderSession(broadcast);

const httpServer = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Static serving of the built UI (SPA fallback to index.html).
  await serveStatic(req.url ?? "/", res);
});

async function serveStatic(urlPath: string, res: import("node:http").ServerResponse): Promise<void> {
  const cleanPath = urlPath.split("?")[0]!;
  const rel = cleanPath === "/" ? "index.html" : normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(WEB_DIST, rel);
  try {
    let body = await readFile(filePath).catch(async () => {
      // SPA fallback: unknown routes serve index.html.
      filePath = join(WEB_DIST, "index.html");
      return readFile(filePath);
    });
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(
      "a-flow-runner server is running, but the web bundle isn't built.\n" +
        "In dev, open the Vite dev server instead (npm run dev:web).\n",
    );
  }
}

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  clients.add(ws);
  // Bring the freshly-connected UI up to date.
  session.snapshot();

  ws.on("message", async (data) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(data.toString()) as ClientCommand;
    } catch {
      return;
    }
    try {
      // Recording and running are mutually exclusive (they share the browser profile).
      if (cmd.type === "startRecording") {
        if (session.isActive) {
          broadcast({ type: "log", level: "warn", message: "Can't record while a run is active." });
          return;
        }
        await recorder.start(cmd.startUrl, cmd.name);
      } else if (cmd.type === "stopRecording") {
        await recorder.stop();
      } else if (cmd.type === "startRun" && recorder.isActive) {
        broadcast({ type: "log", level: "warn", message: "Can't run while recording." });
      } else {
        await session.handleCommand(cmd);
      }
    } catch (err) {
      broadcast({ type: "log", level: "error", message: `Command failed: ${String(err)}` });
    }
  });

  ws.on("close", () => clients.delete(ws));
});

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n[a-flow-runner] FATAL: port ${PORT} is already in use.\n` +
        `Another (possibly stale) server is running. Free it with:\n` +
        `  lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill\n` +
        `…then start again. (Refusing to run, so you don't end up talking to old code.)\n`,
    );
  } else {
    console.error(`[a-flow-runner] server error: ${err.message}`);
  }
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`[a-flow-runner] server listening on http://localhost:${PORT}  (ws: /ws)`);
});
