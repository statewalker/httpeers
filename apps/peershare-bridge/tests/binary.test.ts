/**
 * 14 — Does `bun build --compile` give a one-file Bridge that opens the browser at the right URL?
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_TOKEN_HEADER } from "@statewalker/httpeers-share";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), "../src/main.ts");
const PEERSHARE = "https://tools.sandclaw.ai";
const dir = mkdtempSync(join(tmpdir(), "peershare-14-"));
const binary = join(dir, "peershare-bridge");
let child: ChildProcess | undefined;

const hasBun = (() => {
  try {
    execFileSync("bun", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  if (!hasBun) return;
  execFileSync("bun", ["build", "--compile", MAIN, "--outfile", binary], { stdio: "ignore" });
}, 120_000);
afterAll(() => {
  child?.kill();
});

describe.skipIf(!hasBun)("14 — the compiled Bridge", () => {
  it("is one file", () => {
    expect(existsSync(binary)).toBe(true);
    console.log(`binary: ${(statSync(binary).size / 1e6).toFixed(1)} MB`);
  });

  it("runs with nothing on PATH, and --open opens the PeerShare page at a working pairing URL", async () => {
    // Stands in for `open` / `xdg-open` / `start`: records what it was asked to open.
    const opened = join(dir, "opened.txt");
    const opener = join(dir, "fake-open.sh");
    writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
    chmodSync(opener, 0o755);

    child = spawn(binary, ["--port", "0", "--origin", PEERSHARE, "--open"], {
      env: { PATH: "", PEERSHARE_OPEN: opener },
      stdio: "ignore",
    });
    const url = await waitFor(() =>
      existsSync(opened) ? readFileSync(opened, "utf8") : undefined,
    );

    expect(url.startsWith(`${PEERSHARE}/peer-share#`)).toBe(true);
    const fragment = new URLSearchParams(new URL(url).hash.slice(1));
    const hello = await fetch(`${fragment.get("localUrl")}/`, {
      headers: { origin: PEERSHARE, [BRIDGE_TOKEN_HEADER]: fragment.get("t") ?? "" },
    });
    expect(await hello.json()).toEqual({ bridge: "peershare" });
  }, 30_000);
});

async function waitFor<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value != null && value !== "") return value;
    if (Date.now() - started > ms) throw new Error(`nothing within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
