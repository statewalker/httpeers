/**
 * The `llm` module registered on a real daemon (relay + local door), against
 * a fake LiteLLM — the one daemon-level check the brief asks for, on top of
 * the module's own unit tests. Reuses `daemon.test.ts`'s relay/relayDoc
 * harness shape rather than the full mesh-membership one: the local door is
 * enough to prove `startDaemon` wires the module through end to end.
 */

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { type Relay, startRelay } from "@statewalker/httpeers-relay";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HubConfig } from "../src/config.js";
import { type Daemon, startDaemon } from "../src/daemon.js";
import { llmModule } from "../src/services/llm/index.js";

let relay: Relay;
let relayDoc: Server;
let relayDocUrl: string;
let litellm: Server;
let litellmUpstream: string;
const dirs: string[] = [];
const daemons: Daemon[] = [];

beforeAll(async () => {
  relay = await startRelay({ privateKey: await generateKeyPair("Ed25519"), port: 0 });
  const relayAddrs = relay.node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .filter((addr) => addr.startsWith("/ip4/127.0.0.1/"));
  expect(relayAddrs.length).toBeGreaterThan(0);

  relayDoc = createServer((req, res) => {
    if (req.url !== "/.well-known/httpeers-relay.json") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ relayAddrs }));
  });
  relayDoc.listen(0, "127.0.0.1");
  await once(relayDoc, "listening");
  const relayDocPort = (relayDoc.address() as AddressInfo).port;
  relayDocUrl = `http://127.0.0.1:${relayDocPort}/.well-known/httpeers-relay.json`;

  // The fake LiteLLM: answers /peers/<hubPeerId>/llm/v1/models.
  litellm = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, data: [{ id: "gpt-fake" }] }));
  });
  litellm.listen(0, "127.0.0.1");
  await once(litellm, "listening");
  const litellmPort = (litellm.address() as AddressInfo).port;
  litellmUpstream = `http://127.0.0.1:${litellmPort}`;
});

afterEach(async () => {
  while (daemons.length > 0)
    await daemons
      .pop()
      ?.stop()
      .catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
}, 30_000);

afterAll(async () => {
  relayDoc?.close();
  litellm?.close();
  await relay?.stop();
});

async function configFor(): Promise<HubConfig> {
  const dir = await mkdtemp(join(tmpdir(), "hub-llm-daemon-"));
  dirs.push(dir);
  return {
    dataDir: dir,
    relayDoc: relayDocUrl,
    services: ["llm"],
    joinPageUrl: "https://example.test/mesh.html",
    localDoorPort: 0,
    localDoorHost: "127.0.0.1",
    llmUpstream: litellmUpstream,
    litellmMasterKey: "sk-master-test",
  };
}

describe("startDaemon with the llm module", () => {
  it("serves the llm passthrough through the local door, upstream path prefixed with /peers/<id>", async () => {
    const config = await configFor();
    const module = llmModule({
      upstream: config.llmUpstream as string,
      masterKey: config.litellmMasterKey as string,
    });
    const daemon = await startDaemon(config, [module]);
    daemons.push(daemon);

    const door = `http://127.0.0.1:${daemon.localDoorPort}`;
    const response = await fetch(`${door}/peers/${daemon.hubPeerId}/llm/v1/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { path: string; data: unknown };
    expect(body.path).toBe(`/peers/${daemon.hubPeerId}/llm/v1/models`);
    expect(body.data).toEqual([{ id: "gpt-fake" }]);

    // The curated OpenAPI document is served locally, never proxied.
    const openapi = await fetch(`${door}/peers/${daemon.hubPeerId}/llm/openapi.json`);
    expect(openapi.status).toBe(200);
    expect(((await openapi.json()) as { servers: Array<{ url: string }> }).servers).toEqual([
      { url: "." },
    ]);

    // The advertisement is exposed the way every service module's is.
    expect(
      daemon.hub
        .meshView()
        .advertisements.some((a) => a.id === "llm" && a.kind === "openapi-service"),
    ).toBe(true);
  }, 90_000);
});
