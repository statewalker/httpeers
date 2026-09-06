import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateRelayKey,
  loadRelayKey,
  MissingRelayKeyError,
  resolveRelayKey,
} from "../src/key.js";

let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "httpeers-relay-key-"));
  keyPath = join(dir, ".httpeers", "relay.key");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadRelayKey", () => {
  it("round-trips a generated key", async () => {
    const written = await generateRelayKey(keyPath);
    const read = loadRelayKey(keyPath);
    expect(peerIdFromPrivateKey(read).toString()).toBe(peerIdFromPrivateKey(written).toString());
  });

  it("throws MissingRelayKeyError rather than generating one", () => {
    expect(() => loadRelayKey(keyPath)).toThrow(MissingRelayKeyError);
  });

  it("rejects a non-Ed25519 key -- a mesh identity must be a verifying key", async () => {
    writeFileSync(keyPath.replace("/.httpeers/relay.key", "/rsa.key"), new Uint8Array());
    const secp = await generateKeyPair("secp256k1");
    const p = join(dir, "secp.key");
    writeFileSync(p, privateKeyToProtobuf(secp));
    expect(() => loadRelayKey(p)).toThrow(/only Ed25519 is supported/);
  });
});

describe("resolveRelayKey", () => {
  it("errors when there is neither a key file nor a seed", () => {
    expect(() => resolveRelayKey({ keyPath })).toThrow(MissingRelayKeyError);
  });

  it("seeds a fresh volume from RELAY_KEY and persists it", async () => {
    const original = await generateKeyPair("Ed25519");
    const seed = Buffer.from(privateKeyToProtobuf(original)).toString("base64");

    const resolved = resolveRelayKey({ keyPath, seedBase64: seed });
    expect(peerIdFromPrivateKey(resolved).toString()).toBe(
      peerIdFromPrivateKey(original).toString(),
    );
    // Persisted, so the next start needs no seed.
    expect(readFileSync(keyPath).length).toBeGreaterThan(0);
    expect(peerIdFromPrivateKey(loadRelayKey(keyPath)).toString()).toBe(
      peerIdFromPrivateKey(original).toString(),
    );
  });

  // The regression the whole module exists to prevent: a stale RELAY_KEY left
  // in a server .env must never replace a working identity on redeploy.
  it("ignores RELAY_KEY entirely when a key file already exists", async () => {
    const onDisk = await generateRelayKey(keyPath);
    const stale = await generateKeyPair("Ed25519");
    expect(peerIdFromPrivateKey(stale).toString()).not.toBe(
      peerIdFromPrivateKey(onDisk).toString(),
    );

    const resolved = resolveRelayKey({
      keyPath,
      seedBase64: Buffer.from(privateKeyToProtobuf(stale)).toString("base64"),
    });

    expect(peerIdFromPrivateKey(resolved).toString()).toBe(peerIdFromPrivateKey(onDisk).toString());
  });

  it("treats an empty or whitespace RELAY_KEY as absent", () => {
    expect(() => resolveRelayKey({ keyPath, seedBase64: "   " })).toThrow(MissingRelayKeyError);
  });

  it("is stable across repeated resolution -- the identity never drifts", async () => {
    const first = resolveRelayKey({
      keyPath,
      seedBase64: Buffer.from(privateKeyToProtobuf(await generateKeyPair("Ed25519"))).toString(
        "base64",
      ),
    });
    const second = resolveRelayKey({ keyPath });
    const third = resolveRelayKey({ keyPath });
    expect(peerIdFromPrivateKey(second).toString()).toBe(peerIdFromPrivateKey(first).toString());
    expect(peerIdFromPrivateKey(third).toString()).toBe(peerIdFromPrivateKey(first).toString());
  });
});
