import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertBootstrapAddr,
  bootstrapTempPath,
  buildRelayDocument,
  clearRelayDocument,
  isPublicDialAddr,
  writeRelayDocument,
} from "../src/bootstrap-doc.js";

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

describe("bootstrapTempPath", () => {
  // F4: rename() across devices is EXDEV. The document's directory is a mounted
  // volume, so a temp file in /tmp would make every write fail on the server and
  // succeed on every developer's machine.
  it("is a sibling of the target, never in the system temp directory", () => {
    const target = "/srv/bootstrap/.well-known/httpeers-relay.json";
    expect(dirname(bootstrapTempPath(target))).toBe(dirname(target));
    expect(bootstrapTempPath(target).startsWith(tmpdir())).toBe(false);
  });

  it("is not the target itself", () => {
    const target = "/srv/bootstrap/.well-known/httpeers-relay.json";
    expect(bootstrapTempPath(target)).not.toBe(target);
  });
});

describe("writeRelayDocument", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-bootstrap-doc-"));
    target = join(dir, "bootstrap", ".well-known", "httpeers-relay.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory and writes the document", () => {
    writeRelayDocument(target, [PUBLIC]);
    expect(readFileSync(target, "utf8")).toBe(buildRelayDocument([PUBLIC]));
  });

  it("writes it world-readable, because Caddy reads it as another user", () => {
    writeRelayDocument(target, [PUBLIC]);
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it("replaces an existing document by rename, never by truncating it in place", () => {
    writeRelayDocument(target, [PUBLIC]);
    const before = statSync(target).ino;
    writeRelayDocument(target, [PUBLIC, PUBLIC_ALT]);
    expect(statSync(target).ino).not.toBe(before);
    expect(readFileSync(target, "utf8")).toBe(buildRelayDocument([PUBLIC, PUBLIC_ALT]));
  });

  it("leaves no temp file behind", () => {
    writeRelayDocument(target, [PUBLIC]);
    expect(readdirSync(dirname(target))).toEqual(["httpeers-relay.json"]);
  });

  it("leaves the previous document intact when there is nothing publishable to write", () => {
    writeRelayDocument(target, [PUBLIC]);
    expect(() => writeRelayDocument(target, [`/ip4/172.18.0.3/tcp/9090/ws/p2p/${PEER}`])).toThrow(
      /no publishable address/,
    );
    expect(readFileSync(target, "utf8")).toBe(buildRelayDocument([PUBLIC]));
    expect(readdirSync(dirname(target))).toEqual(["httpeers-relay.json"]);
  });

  it("cleans the temp file up when the rename fails", () => {
    mkdirSync(target, { recursive: true }); // a directory where the document belongs
    expect(() => writeRelayDocument(target, [PUBLIC])).toThrow();
    expect(readdirSync(dirname(target))).toEqual(["httpeers-relay.json"]);
  });
});

describe("clearRelayDocument", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-bootstrap-doc-"));
    target = join(dir, "bootstrap", ".well-known", "httpeers-relay.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // F5: a relay that fails to start must not leave a document behind claiming
  // it is dialable. Clearing happens before the relay is even attempted, so a
  // crash-looping relay yields 404 rather than a confident lie.
  it("removes an existing document", () => {
    writeRelayDocument(target, [PUBLIC]);
    clearRelayDocument(target);
    expect(existsSync(target)).toBe(false);
  });

  it("removes a stale temp file too", () => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(bootstrapTempPath(target), "partial");
    clearRelayDocument(target);
    expect(existsSync(bootstrapTempPath(target))).toBe(false);
  });

  it("is a no-op when there is no document, and when there is no directory", () => {
    expect(() => clearRelayDocument(target)).not.toThrow();
    expect(() => clearRelayDocument(join(dir, "nowhere", "at", "all.json"))).not.toThrow();
  });
});
