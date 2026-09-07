import { describe, expect, it } from "vitest";
import { assertBootstrapAddr, buildRelayDocument, isPublicDialAddr } from "../src/bootstrap-doc.js";

const PEER = "12D3KooWGzeWbY26SR3HC7tYBf9BNkJp6vyT5CevAJiZQVE29fFa";
const PUBLIC = `/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/${PEER}`;
const PUBLIC_ALT = `/dns4/relay-2.httpeers.net/tcp/443/tls/ws/p2p/${PEER}`;

describe("assertBootstrapAddr", () => {
  // F2: this is the exact INVERSE of assertAnnounceAddr, which REJECTS /p2p/.
  // Importing that one here would assert nothing at all.
  it("accepts an address carrying exactly one /p2p/", () => {
    expect(() => assertBootstrapAddr(PUBLIC)).not.toThrow();
  });

  it("rejects an address carrying no /p2p/ -- pinning would be impossible", () => {
    expect(() => assertBootstrapAddr("/dns4/relay.httpeers.net/tcp/443/tls/ws")).toThrow(
      /exactly one \/p2p\//,
    );
  });

  it("rejects an address carrying two /p2p/, which libp2p produces when announce carries one", () => {
    expect(() => assertBootstrapAddr(`${PUBLIC}/p2p/${PEER}`)).toThrow(/exactly one \/p2p\//);
  });

  it("rejects an unparseable multiaddr", () => {
    expect(() => assertBootstrapAddr("relay.httpeers.net:443")).toThrow(/not a valid multiaddr/);
  });
});

describe("isPublicDialAddr", () => {
  it("keeps a dns-named address", () => {
    expect(isPublicDialAddr(PUBLIC)).toBe(true);
  });

  it("keeps a public IP literal", () => {
    expect(isPublicDialAddr(`/ip4/163.172.46.87/tcp/443/tls/ws/p2p/${PEER}`)).toBe(true);
  });

  it("drops the unspecified address the relay binds", () => {
    expect(isPublicDialAddr(`/ip4/0.0.0.0/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
    expect(isPublicDialAddr(`/ip6/::/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
  });

  it("drops loopback", () => {
    expect(isPublicDialAddr(`/ip4/127.0.0.1/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
    expect(isPublicDialAddr(`/ip6/::1/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
  });

  // The one a container actually produces: Docker's default bridge subnet.
  it("drops the container-internal RFC1918 address", () => {
    expect(isPublicDialAddr(`/ip4/172.18.0.3/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
    expect(isPublicDialAddr(`/ip4/10.0.0.4/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
    expect(isPublicDialAddr(`/ip4/192.168.1.7/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
  });

  it("keeps 172.32, which is outside RFC1918 despite the prefix", () => {
    expect(isPublicDialAddr(`/ip4/172.32.0.1/tcp/443/tls/ws/p2p/${PEER}`)).toBe(true);
  });

  it("drops link-local and unique-local", () => {
    expect(isPublicDialAddr(`/ip4/169.254.1.1/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
    expect(isPublicDialAddr(`/ip6/fe80::1/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
    expect(isPublicDialAddr(`/ip6/fd00::1/tcp/9090/ws/p2p/${PEER}`)).toBe(false);
  });

  it("drops a circuit address -- a relay is dialled directly or not at all", () => {
    expect(isPublicDialAddr(`/dns4/other.example/tcp/443/tls/ws/p2p/${PEER}/p2p-circuit`)).toBe(
      false,
    );
  });
});

describe("buildRelayDocument", () => {
  it("emits the relayAddrs shape httpeers.json already uses", () => {
    expect(JSON.parse(buildRelayDocument([PUBLIC]))).toEqual({ relayAddrs: [PUBLIC] });
  });

  it("is byte-identical across calls", () => {
    expect(buildRelayDocument([PUBLIC, PUBLIC_ALT])).toBe(buildRelayDocument([PUBLIC, PUBLIC_ALT]));
  });

  // Determinism has to survive the ORDER libp2p happens to report addresses in,
  // which is not a documented guarantee.
  it("is byte-identical regardless of input order", () => {
    expect(buildRelayDocument([PUBLIC, PUBLIC_ALT])).toBe(buildRelayDocument([PUBLIC_ALT, PUBLIC]));
  });

  it("sorts the addresses", () => {
    const doc = JSON.parse(buildRelayDocument([PUBLIC, PUBLIC_ALT])) as { relayAddrs: string[] };
    expect(doc.relayAddrs).toEqual([...doc.relayAddrs].sort());
  });

  it("de-duplicates", () => {
    const doc = JSON.parse(buildRelayDocument([PUBLIC, PUBLIC])) as { relayAddrs: string[] };
    expect(doc.relayAddrs).toEqual([PUBLIC]);
  });

  it("carries no timestamp, version or other field that differs between regenerations", () => {
    expect(Object.keys(JSON.parse(buildRelayDocument([PUBLIC])))).toEqual(["relayAddrs"]);
  });

  it("ends with a newline, so the file is not a partial line", () => {
    expect(buildRelayDocument([PUBLIC]).endsWith("\n")).toBe(true);
  });

  it("drops container-internal addresses and keeps the public one", () => {
    const doc = JSON.parse(
      buildRelayDocument([`/ip4/0.0.0.0/tcp/9090/ws/p2p/${PEER}`, PUBLIC]),
    ) as { relayAddrs: string[] };
    expect(doc.relayAddrs).toEqual([PUBLIC]);
  });

  it("emits exactly one /p2p/ per address", () => {
    const doc = JSON.parse(buildRelayDocument([PUBLIC, PUBLIC_ALT])) as { relayAddrs: string[] };
    for (const addr of doc.relayAddrs) expect(addr.split("/p2p/").length - 1).toBe(1);
  });

  // An empty document is a worse lie than no document: a peer would fetch it,
  // parse it, and conclude the relay has no address.
  it("refuses to emit an empty address list", () => {
    expect(() => buildRelayDocument([])).toThrow(/no publishable address/);
    expect(() => buildRelayDocument([`/ip4/172.18.0.3/tcp/9090/ws/p2p/${PEER}`])).toThrow(
      /no publishable address/,
    );
  });

  it("refuses an address with no peer id rather than publishing an unpinnable one", () => {
    expect(() => buildRelayDocument(["/dns4/relay.httpeers.net/tcp/443/tls/ws"])).toThrow(
      /exactly one \/p2p\//,
    );
  });
});
