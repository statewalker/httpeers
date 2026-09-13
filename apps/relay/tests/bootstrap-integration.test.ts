/**
 * Integration: the document a real relay writes, against what that same relay
 * actually advertises.
 *
 * THE ASSERTION THAT MATTERS is `relayAddrs` === `node.getMultiaddrs()`. Every
 * other check here is hygiene. Generating the document from
 * `RELAY_ANNOUNCE_ADDRS` instead would pass every unit test in
 * `bootstrap-doc.test.ts` and would be a second source of truth for the relay's
 * address, free to drift from what peers are told in the one direction nobody
 * looks. This test is what makes that drift impossible rather than discouraged,
 * so it runs `main.ts` as the container runs it -- a subprocess, configured only
 * through the environment -- rather than calling the writer directly.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicAnnounceAddr } from "../src/addresses.js";
import { buildRelayDocument, isPublicDialAddr } from "../src/bootstrap-doc.js";
import { generateRelayKey } from "../src/key.js";
import { type Relay, startRelay } from "../src/relay.js";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(APP_DIR, "node_modules", ".bin", "tsx");
const MAIN = join(APP_DIR, "src", "main.ts");
const PORT = 19_091;
const ANNOUNCE = publicAnnounceAddr("relay.httpeers.net");

let dir: string;
let keyPath: string;
let docPath: string;
let peerId: string;
let relay: Relay | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "httpeers-bootstrap-int-"));
  keyPath = join(dir, "relay.key");
  docPath = join(dir, "bootstrap", ".well-known", "httpeers-relay.json");
  peerId = peerIdFromPrivateKey(await generateRelayKey(keyPath)).toString();
});

afterEach(async () => {
  await relay?.stop();
  relay = undefined;
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Runs `main.ts` the way the container does, waits for `ready` to match its
 * stdout, then stops it. Returns the STARTUP output only -- everything before
 * the shutdown notice -- so two runs can be compared byte for byte.
 */
async function runMain(env: Record<string, string>, ready: RegExp): Promise<Run> {
  const child: ChildProcessWithoutNullStreams = spawn(TSX, [MAIN], {
    cwd: APP_DIR,
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  let code: number | null = null;
  let done = false;
  exited.then((c) => {
    code = c;
    done = true;
  });

  for (let i = 0; i < 200 && !done && !ready.test(stdout); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!done) {
    child.kill("SIGTERM");
    await exited;
  }
  return { stdout: stdout.split("\nrelay: received ")[0] as string, stderr, code };
}

function baseEnv(): Record<string, string> {
  return {
    RELAY_PORT: String(PORT),
    RELAY_KEY_PATH: keyPath,
    RELAY_ANNOUNCE_ADDRS: ANNOUNCE,
    RELAY_KEY: "",
  };
}

describe("the document a running relay publishes", () => {
  it("contains exactly what node.getMultiaddrs() advertises", async () => {
    const privateKey = await generateRelayKey(join(dir, "in-process.key"));
    relay = await startRelay({ privateKey, port: PORT, announce: [ANNOUNCE] });
    const advertised = relay.node.getMultiaddrs().map(String);

    const doc = JSON.parse(buildRelayDocument(advertised)) as { relayAddrs: string[] };
    expect(doc.relayAddrs).toEqual(advertised.filter(isPublicDialAddr).sort());
    expect(doc.relayAddrs.length).toBeGreaterThan(0);
    for (const addr of doc.relayAddrs) {
      expect(addr.split("/p2p/").length - 1).toBe(1);
      expect(addr.endsWith(`/p2p/${relay.node.peerId.toString()}`)).toBe(true);
      expect(addr).not.toContain("0.0.0.0");
      expect(addr).not.toContain(`/tcp/${PORT}/`);
    }
  });
});

describe("main.ts, run as the container runs it", () => {
  it("writes the document to RELAY_BOOTSTRAP_PATH, matching the addresses it printed", async () => {
    const run = await runMain(
      { ...baseEnv(), RELAY_BOOTSTRAP_PATH: docPath },
      /wrote the bootstrap document/,
    );
    expect(run.stderr).toBe("");
    expect(existsSync(docPath)).toBe(true);

    const printed = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("  /"))
      .map((line) => line.trim());
    const doc = JSON.parse(readFileSync(docPath, "utf8")) as { relayAddrs: string[] };
    expect(doc.relayAddrs).toEqual(printed.filter(isPublicDialAddr).sort());
    expect(doc.relayAddrs).toEqual([`${ANNOUNCE}/p2p/${peerId}`]);
  });

  it("writes the same bytes on a second start of the same relay", async () => {
    await runMain({ ...baseEnv(), RELAY_BOOTSTRAP_PATH: docPath }, /wrote the bootstrap document/);
    const first = readFileSync(docPath, "utf8");
    await runMain({ ...baseEnv(), RELAY_BOOTSTRAP_PATH: docPath }, /wrote the bootstrap document/);
    expect(readFileSync(docPath, "utf8")).toBe(first);
  });

  // Opt-in: local runs and anyone who has not set the variable must see the
  // relay behave exactly as it did before this feature existed.
  it("writes nothing and prints nothing extra when RELAY_BOOTSTRAP_PATH is unset", async () => {
    const run = await runMain(baseEnv(), /relay addrs:\n {2}\//);
    expect(run.stdout).toBe(`relay peerId: ${peerId}\nrelay addrs:\n  ${ANNOUNCE}/p2p/${peerId}\n`);
    expect(existsSync(docPath)).toBe(false);
    expect(existsSync(dirname(docPath))).toBe(false);
  });

  it("adds its line after that output rather than changing it", async () => {
    const withDoc = await runMain(
      { ...baseEnv(), RELAY_BOOTSTRAP_PATH: docPath },
      /wrote the bootstrap document/,
    );
    const without = await runMain(baseEnv(), /relay addrs:\n {2}\//);
    expect(withDoc.stdout.startsWith(without.stdout)).toBe(true);
  });

  // F5. The stale document is the dangerous case: Caddy would serve it happily
  // while the relay crash-loops, so peers bootstrap onto a relay that is down.
  it("removes a stale document even when it then fails to start", async () => {
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, '{"relayAddrs":["/dns4/stale.example/tcp/443/tls/ws/p2p/12D3Koo"]}\n');

    const run = await runMain(
      { ...baseEnv(), RELAY_KEY_PATH: join(dir, "absent.key"), RELAY_BOOTSTRAP_PATH: docPath },
      /never matches/,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/no signing key found/);
    expect(existsSync(docPath)).toBe(false);
  });

  // Skipped as root, which is not a gap in coverage: a root process cannot be
  // denied a write by file permissions, so there is no failure to observe.
  it.skipIf(process.getuid?.() === 0)(
    "fails loudly rather than running on with the document silently absent",
    async () => {
      const unwritable = join(dir, "unwritable");
      mkdirSync(unwritable, { mode: 0o500 });
      const run = await runMain(
        { ...baseEnv(), RELAY_BOOTSTRAP_PATH: join(unwritable, "sub", "doc.json") },
        /never matches/,
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/could not write the bootstrap document/);
    },
  );
});
