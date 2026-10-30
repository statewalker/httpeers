/** A local Service for the Bridge to relay to. */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export interface Running {
  origin: string;
  close(): Promise<void>;
}

export async function startService(): Promise<Running> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/login") {
      res.writeHead(200, { "set-cookie": "session=claudia; Path=/" }).end("ok");
      return;
    }
    if (url.pathname === "/whoami") {
      res.writeHead(200).end(/session=(\w+)/.exec(req.headers.cookie ?? "")?.[1] ?? "anonymous");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "dirk", path: url.pathname }));
  });
  // A live channel too: echoes what it is sent.
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (data) => socket.send(`echo ${data}`)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
      }),
  };
}
