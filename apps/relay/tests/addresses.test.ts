import { describe, expect, it } from "vitest";
import {
  assertAnnounceAddr,
  DEFAULT_RELAY_PORT,
  listenAddrs,
  parseAnnounceAddrs,
  publicAnnounceAddr,
} from "../src/addresses.js";

describe("listenAddrs", () => {
  it("binds plain ws, never tls -- the proxy holds the certificate", () => {
    expect(listenAddrs(9090)).toEqual(["/ip4/0.0.0.0/tcp/9090/ws"]);
    expect(listenAddrs(9090)[0]).not.toContain("tls");
  });

  it("defaults to the port the design names", () => {
    expect(listenAddrs()).toEqual([`/ip4/0.0.0.0/tcp/${DEFAULT_RELAY_PORT}/ws`]);
  });
});

describe("publicAnnounceAddr", () => {
  it("uses /tls/ws, the spelling @libp2p/websockets 10.1.19 documents", () => {
    expect(publicAnnounceAddr("relay.httpeers.net")).toBe(
      "/dns4/relay.httpeers.net/tcp/443/tls/ws",
    );
  });

  it("does not use the legacy /wss shorthand", () => {
    expect(publicAnnounceAddr("relay.httpeers.net")).not.toContain("/wss");
  });

  it("is itself a valid announce address", () => {
    expect(() => assertAnnounceAddr(publicAnnounceAddr("relay.httpeers.net"))).not.toThrow();
  });
});

describe("assertAnnounceAddr", () => {
  it("accepts a proxy-fronted address", () => {
    expect(() => assertAnnounceAddr("/dns4/relay.httpeers.net/tcp/443/tls/ws")).not.toThrow();
  });

  // The likely operator mistake: the address in the logs and in httpeers.json
  // DOES carry /p2p/<id>, so pasting it here looks obviously right.
  it("rejects an address carrying /p2p/, which libp2p would double", () => {
    expect(() =>
      assertAnnounceAddr("/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3KooWaBcDeF"),
    ).toThrow(/must not contain a \/p2p\/ component/);
  });

  it("rejects an unparseable multiaddr rather than letting libp2p throw later", () => {
    expect(() => assertAnnounceAddr("relay.httpeers.net:443")).toThrow(/not a valid multiaddr/);
  });
});

describe("parseAnnounceAddrs", () => {
  it("treats an absent value as no announce addresses", () => {
    expect(parseAnnounceAddrs(undefined)).toEqual([]);
  });

  it("treats an empty or whitespace value as no announce addresses", () => {
    expect(parseAnnounceAddrs("")).toEqual([]);
    expect(parseAnnounceAddrs("  ,  ")).toEqual([]);
  });

  it("splits a comma-separated list and trims each entry", () => {
    expect(
      parseAnnounceAddrs("/dns4/a.example/tcp/443/tls/ws , /dns4/b.example/tcp/443/tls/ws"),
    ).toEqual(["/dns4/a.example/tcp/443/tls/ws", "/dns4/b.example/tcp/443/tls/ws"]);
  });

  it("validates every entry, not just the first", () => {
    expect(() => parseAnnounceAddrs("/dns4/a.example/tcp/443/tls/ws,not-a-multiaddr")).toThrow(
      /not a valid multiaddr/,
    );
  });
});
