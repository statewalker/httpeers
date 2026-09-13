/**
 * The bootstrap document -- what a peer that knows only a URL needs in order
 * to dial this relay, and nothing else.
 *
 * Published by Caddy at `https://relay.httpeers.net/.well-known/httpeers-relay.json`;
 * this module only produces the bytes. The relay still serves nothing (see
 * `relay.ts`): writing a file is the same act as printing the address list to
 * stdout, one destination further.
 *
 * ITS INPUT IS `node.getMultiaddrs()`, NEVER CONFIGURATION. Building it from
 * `RELAY_ANNOUNCE_ADDRS` would look equivalent and would be a second source of
 * truth for the relay's address -- free to drift from what the relay actually
 * advertises, in the one direction nobody checks. Taking the node's own view
 * makes that drift structurally impossible rather than merely unlikely, which
 * is the whole reason this module exists rather than a `JSON.stringify` in
 * `main.ts`.
 *
 * `assertBootstrapAddr` IS THE INVERSE OF `assertAnnounceAddr`, NOT A REUSE OF
 * IT. An announce address must NOT carry `/p2p/` -- libp2p appends the peer id
 * itself. A published address MUST carry exactly one, because that peer id is
 * the entire security value of the document: it is what the client pins and
 * what Noise verifies afterwards. Wiring `assertAnnounceAddr` in here would
 * reject every correct address and, if the sense were flipped by hand, assert
 * nothing at all.
 *
 * NO TIMESTAMP AND NO VERSION FIELD, so an unchanged relay regenerates the
 * same bytes and a redeploy can be diffed against the previous one to nothing.
 * That is the whole of the claim, and it is worth stating narrowly: it is NOT a
 * caching benefit. `Cache-Control: max-age=300` turns caches over regardless,
 * and Caddy's `file_server` derives its ETag from the file's mtime and size, so
 * rewriting identical bytes still changes the ETag -- measured, not assumed.
 * What byte-identity buys is that "did the relay's address change?" is answered
 * by comparing content, with no field that differs for its own sake.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { multiaddr } from "@multiformats/multiaddr";

/** The URL path Caddy publishes this at. Referenced by the docs; never served by this process. */
export const RELAY_DOCUMENT_URL_PATH = "/.well-known/httpeers-relay.json";

/** The shape. `relayAddrs` is the key `httpeers.json`'s invitation payload already uses. */
export interface RelayDocument {
  relayAddrs: string[];
}

/**
 * Rejects an address that cannot be published.
 *
 * The exact inverse of `addresses.ts`' `assertAnnounceAddr`: that one rejects
 * `/p2p/`, this one requires exactly one. Two would mean an announce address
 * was hand-written with the peer id already in it and libp2p appended a second;
 * none would mean an address a client cannot pin, which is the one property
 * this document exists to deliver.
 */
export function assertBootstrapAddr(addr: string): void {
  try {
    multiaddr(addr);
  } catch (err) {
    throw new Error(
      `relay: published address "${addr}" is not a valid multiaddr: ${(err as Error).message}`,
    );
  }
  const count = addr.split("/p2p/").length - 1;
  if (count !== 1) {
    throw new Error(
      `relay: published address "${addr}" carries ${count} /p2p/ components; exactly one /p2p/ ` +
        "is required. The peer id is what a client pins and what Noise verifies afterwards, so an " +
        "address without one cannot be published, and one with two means an announce address " +
        "was written carrying a peer id that libp2p then appended to again.",
    );
  }
}

function isPrivateIp4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8, which includes the unspecified address
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true; // NOT all of 172/8 -- 172.32 is public
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIp6(value: string): boolean {
  const v = value.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fe80:")) return true; // link-local
  if (/^f[cd]/.test(v)) return true; // unique-local, fc00::/7
  return false;
}

/**
 * Whether an address is one an outside peer could actually dial.
 *
 * The address the relay binds is `/ip4/0.0.0.0/tcp/9090/ws` and, on a Docker
 * network, its interface address is in `172.16/12`. Publishing either produces
 * the deployment's signature failure -- a relay that is healthy, advertised,
 * and undialable -- with the symptom pointing at the relay rather than at the
 * address peers were handed. `RELAY_ANNOUNCE_ADDRS` normally means
 * `getMultiaddrs()` reports only the public address, so this filter is a second
 * line rather than the first.
 *
 * Circuit addresses are dropped too: the relay is dialled directly or not at
 * all, and a relay reachable only through another relay is not a bootstrap.
 */
export function isPublicDialAddr(addr: string): boolean {
  if (addr.includes("/p2p-circuit")) return false;
  let components: ReturnType<ReturnType<typeof multiaddr>["getComponents"]>;
  try {
    components = multiaddr(addr).getComponents();
  } catch {
    return false;
  }
  for (const component of components) {
    if (component.value == null) continue;
    if (component.name === "ip4" && isPrivateIp4(component.value)) return false;
    if (component.name === "ip6" && isPrivateIp6(component.value)) return false;
  }
  return true;
}

/**
 * The document, as bytes, from the addresses the node actually advertises.
 *
 * Sorted and de-duplicated because `getMultiaddrs()` guarantees no order, and
 * an unstable order would mean a document that differs between two runs of an
 * unchanged relay.
 *
 * Throws when nothing survives filtering. An empty `relayAddrs` is a worse
 * outcome than no document at all: a peer would fetch it, parse it happily, and
 * conclude the relay has no address -- whereas a missing document is an error
 * it can report.
 */
export function buildRelayDocument(addrs: string[]): string {
  const publishable = [...new Set(addrs.filter(isPublicDialAddr))].sort();
  for (const addr of publishable) assertBootstrapAddr(addr);
  if (publishable.length === 0) {
    throw new Error(
      "relay: no publishable address to put in the bootstrap document.\n" +
        `relay: the node advertises [${addrs.join(", ")}], all of which are container-internal,\n` +
        "relay: loopback or circuit addresses that no outside peer can dial. Check\n" +
        "relay: RELAY_ANNOUNCE_ADDRS -- see apps/relay/src/addresses.ts.",
    );
  }
  const doc: RelayDocument = { relayAddrs: publishable };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Where the document is staged before it is renamed into place.
 *
 * A SIBLING OF THE TARGET, NOT `/tmp`. `rename()` is atomic only within one
 * filesystem; across devices it fails with `EXDEV`. The document's directory is
 * a mounted volume, so staging in the system temp directory would work on every
 * developer's machine and fail on the server -- the worst distribution of
 * outcomes available.
 *
 * A fixed name rather than a random one, so that a temp file left by a killed
 * process is found and removed by `clearRelayDocument` instead of accumulating.
 * One relay process owns this path; there is no concurrent writer to collide
 * with.
 */
export function bootstrapTempPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.tmp`);
}

/**
 * Removes the document, and any temp file beside it. Idempotent.
 *
 * CALLED BEFORE THE RELAY IS STARTED, not after. "Rewritten on every start"
 * does not cover *failing* to start: a relay that crash-loops would otherwise
 * leave the previous document in place, and Caddy would keep serving it,
 * confidently pointing peers at a relay that is down. Clearing first makes a
 * relay that cannot start yield 404 -- an error a client can act on -- rather
 * than a stale answer it cannot tell from a live one.
 */
export function clearRelayDocument(path: string): void {
  rmSync(bootstrapTempPath(path), { force: true });
  rmSync(path, { force: true });
}

/**
 * Writes the document atomically: build, stage beside the target, rename.
 *
 * `rename()` within a filesystem is atomic, so a reader -- Caddy, or a peer
 * fetching through it -- sees either the previous document or the new one, and
 * never a half-written file. The build happens first and throws before anything
 * on disk is touched, so an unpublishable address list leaves whatever was
 * there untouched rather than replacing it with wreckage.
 *
 * Mode `0644` explicitly, because Caddy reads this file as a different user
 * than the one the relay writes it as, and `writeFileSync`'s mode is subject to
 * the process umask.
 */
export function writeRelayDocument(path: string, addrs: string[]): void {
  const doc = buildRelayDocument(addrs);
  const tmp = bootstrapTempPath(path);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tmp, doc, { mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
