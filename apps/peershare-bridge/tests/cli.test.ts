/**
 * 02 — the same Bridge, launched the way Way A will launch it: `bun run`.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_MARKER,
  BRIDGE_TARGET_HEADER,
  BRIDGE_TOKEN_HEADER,
} from "@statewalker/httpeers-share";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Running, startService } from "./fixtures.js";

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), "../src/main.ts");
const PEERSHARE = "https://tools.sandclaw.ai";

let service: Running;
let child: ChildProcess | undefined;

beforeAll(async () => {
  service = await startService();
});
afterAll(async () => {
  child?.kill();
  await service?.close();
});

/** Starts the Bridge under Bun; resolves with the PeerShare URL it prints. */
function launch(): Promise<URL> {
  child = spawn("bun", ["run", MAIN, "--port", "0", "--origin", PEERSHARE], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((done, fail) => {
    let out = "";
    child?.stdout?.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n").find((l) => l.startsWith(`${PEERSHARE}/peer-share#`));
      if (line != null) done(new URL(line.trim()));
    });
    child?.on("exit", (code) => fail(new Error(`bridge exited (${code}): ${out}`)));
    setTimeout(() => fail(new Error(`no URL printed: ${out}`)), 10_000);
  });
}

describe.skipIf(!hasBun())("02 — the Bridge under Bun", () => {
  it("prints the PeerShare URL with where to reach it and a fresh token, and that URL works", async () => {
    const url = await launch();
    const fragment = new URLSearchParams(url.hash.slice(1));
    const localUrl = fragment.get("localUrl");
    const token = fragment.get("t");

    // 127.0.0.1, not localhost: the Bridge binds IPv4 loopback only, and a
    // browser may try `localhost` as ::1 first.
    expect(localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url

    const res = await fetch(`${localUrl}/echo/from-bun`, {
      headers: {
        origin: PEERSHARE,
        [BRIDGE_TARGET_HEADER]: service.origin,
        [BRIDGE_TOKEN_HEADER]: token ?? "",
      },
    });
    expect(res.headers.get(BRIDGE_MARKER)).toBe("relayed");
    expect(await res.json()).toMatchObject({ path: "/echo/from-bun" });
  });
});

describe.skipIf(!hasBun())("the Bridge program, WebSockets (M9)", () => {
  it("relays a WebSocket to the app, under Bun", async () => {
    child?.kill();
    const url = await launch();
    const fragment = new URLSearchParams(url.hash.slice(1));
    const q = new URLSearchParams({ target: `${service.origin}/live` });
    const { WebSocket: WS } = await import("ws");
    const ws = new WS(
      `${fragment.get("localUrl")?.replace("http:", "ws:")}/.peershare/socket?${q}`,
      [`peershare.${fragment.get("t")}`],
      { origin: PEERSHARE },
    );
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (data) => resolve(String(data)));
      ws.on("error", reject);
    });
    expect(reply).toBe("echo ping");
    ws.close();
  });
});

describe.skipIf(!hasBun())("the Bridge program, defaults", () => {
  it("keeps each Guest's cookies (M9): a login survives to that Guest's next request", async () => {
    child?.kill();
    const url = await launch();
    const fragment = new URLSearchParams(url.hash.slice(1));
    const as = (path: string) =>
      fetch(`${fragment.get("localUrl")}${path}`, {
        headers: {
          [BRIDGE_TARGET_HEADER]: service.origin,
          [BRIDGE_TOKEN_HEADER]: fragment.get("t") ?? "",
          "x-peershare-guest": "12D3KooWClaudia",
        },
      }).then((r) => r.text());

    await as("/login");
    expect(await as("/whoami")).toBe("claudia");
  });
});

function hasBun(): boolean {
  try {
    execFileSync("bun", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
