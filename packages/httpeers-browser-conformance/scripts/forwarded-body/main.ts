/**
 * The page `../forwarded-body.mjs` drives: a REAL browser member, joined to a
 * real (local) mesh, posting bodies to a peer through the real forwarders.
 *
 * WHAT A POST CROSSES HERE, and why each hop is the production one:
 *
 *   page fetch()  ->  ServiceWorker (`webrun-http-browser`'s sw-worker)
 *     -> MessagePort  ->  `createGateway`              (the session's /peers/ mount)
 *     -> `MemberHandle.fetch` = `createEdgeDispatch`   (the member edge)
 *     -> `peer.dispatch` = `createPeerRouter`          (the relay-forward branch)
 *     -> libp2p `/httpeers/1.0.0` over the relay       (the transport)
 *     -> the hub's `/echo`, which reports what arrived.
 *
 * Every one of those rebuilt the request at some point, and in Firefox -- no
 * `Request.prototype.body` -- three of them used to drop the payload silently.
 * `apps/session-shell/scripts/browser-test.mjs` stops at the MessagePort with a
 * stand-in handler, which is why it never saw that.
 *
 * Configuration arrives on the query string: `relay`, `hub`, `invitation`, and
 * `mux=1` to run the member on the experimental one-mux-per-peer path (#56).
 * The verdict is left on `window.__forwardedBody` for the script to read.
 */

import { ruleSet } from "@statewalker/httpeers-access";
import { createMounts, type FetchHandler } from "@statewalker/httpeers-core";
import { generateKey, MUX_PER_PEER_GLOBAL } from "@statewalker/httpeers-libp2p";
import { createGateway, startMember } from "@statewalker/httpeers-member";
import { browserPlatform, mountEdge } from "@statewalker/httpeers-member/browser";

interface CaseResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

type Verdict =
  | { state: "running"; step: string }
  | { state: "done"; results: CaseResult[]; hubLink: string }
  | { state: "error"; step: string; message: string };

const w = window as unknown as { __forwardedBody: Verdict };
let step = "reading the configuration";
const setState = (s: string) => {
  step = s;
  w.__forwardedBody = { state: "running", step };
  const el = document.getElementById("state");
  if (el) el.textContent = s;
};

/** The edge key the member mounts at, as the demos' `EDGE_KEY`. */
const EDGE_KEY = "peers";
/** The gateway's mount: the session shell's `MESH_PREFIX` plays this part in production. */
const GATEWAY_KEY = "mesh";

/** The member serves nothing here; the rules only have to parse. */
const RULES = ruleSet({
  version: 1,
  rules: ['capability("app:read") <- role("member");'],
  policies: ['allow if capability("app:read");'],
});

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  // getRandomValues caps one call at 64 KiB.
  for (let i = 0; i < length; i += 65_536) crypto.getRandomValues(out.subarray(i, i + 65_536));
  return out;
}

/**
 * Whether this engine can construct a Request with a ReadableStream body --
 * the standard detection: an engine without it stringifies the stream (and so
 * sets a text content-type) and never reads `duplex`.
 */
function supportsRequestStreams(): boolean {
  let duplexAccessed = false;
  try {
    const hasContentType = new Request("http://x.invalid/", {
      method: "POST",
      body: new ReadableStream(),
      get duplex() {
        duplexAccessed = true;
        return "half";
      },
    } as RequestInit).headers.has("content-type");
    return duplexAccessed && !hasContentType;
  } catch {
    return false;
  }
}

/** What the hub's `/echo` answers: what it received, measured on the far side. */
interface Echo {
  method: string;
  bytes: number;
  sha256: string;
}

async function readEcho(res: Response): Promise<Echo | string> {
  const text = await res.text();
  if (!res.ok) return `HTTP ${res.status}: ${text.slice(0, 200)}`;
  try {
    return JSON.parse(text) as Echo;
  } catch {
    return `not JSON: ${text.slice(0, 200)}`;
  }
}

async function bodyCase(
  name: string,
  sent: Uint8Array,
  call: () => Promise<Response>,
): Promise<CaseResult> {
  try {
    const echo = await readEcho(await call());
    if (typeof echo === "string") return { name, status: "fail", detail: echo };
    const expected = await sha256(sent);
    const ok = echo.method === "POST" && echo.bytes === sent.byteLength && echo.sha256 === expected;
    return {
      name,
      status: ok ? "pass" : "fail",
      detail: `${echo.bytes} bytes of ${sent.byteLength} arrived${
        ok ? "" : echo.bytes === sent.byteLength ? " (content differs)" : ""
      }`,
    };
  } catch (err) {
    return { name, status: "fail", detail: `threw: ${String((err as Error)?.message ?? err)}` };
  }
}

async function run(): Promise<void> {
  const params = new URL(location.href).searchParams;
  const relay = params.get("relay");
  const hub = params.get("hub");
  const invitation = params.get("invitation");
  if (relay == null || hub == null || invitation == null) {
    throw new Error("the page needs ?relay=&hub=&invitation=");
  }
  // Before the member is built: the transport reads the switch when it builds
  // each link, and the layers between here and it do not forward the option.
  if (params.get("mux") === "1") {
    (globalThis as Record<string, unknown>)[MUX_PER_PEER_GLOBAL] = true;
  }

  setState("joining the mesh");
  const member = await startMember({
    key: EDGE_KEY,
    mounts: createMounts(),
    rules: RULES,
    config: { relayAddrs: [relay], hubPeerId: hub },
    // `dev`: the relay is ws://127.0.0.1, which the browser gater refuses otherwise.
    platform: browserPlatform({ serviceWorkerUrl: "/sw.js", dev: true }),
    invitationId: invitation,
    privateKey: await generateKey(),
  });
  if (member.baseUrl == null) throw new Error("the member mounted no edge");

  // THE SESSION'S MESH MOUNT, composed as `apps/demos/src/shared/session-frame.ts`
  // composes it: `createGateway` over the member's own edge dispatch.
  setState("mounting the gateway");
  const gateway: FetchHandler = createGateway({
    source: {
      peerId: member.peerId,
      fetch: (request) => member.fetch(request),
      meshView: () => member.meshView(),
    },
    basePath: `/${GATEWAY_KEY}`,
    edgeKey: EDGE_KEY,
  });
  const gatewayEdge = await mountEdge({
    key: GATEWAY_KEY,
    dispatch: gateway,
    serviceWorkerUrl: "/sw.js",
  });

  const viaEdge = new URL(`${hub}/echo`, member.baseUrl).href;
  const viaGateway = new URL(`${hub}/echo`, gatewayEdge.baseUrl).href;
  const results: CaseResult[] = [];

  setState("GET control");
  {
    const echo = await readEcho(await fetch(viaGateway));
    const ok = typeof echo !== "string" && echo.method === "GET" && echo.bytes === 0;
    results.push({
      name: "GET through the gateway reaches the peer (control)",
      status: ok ? "pass" : "fail",
      detail: typeof echo === "string" ? echo : `${echo.method}, ${echo.bytes} bytes`,
    });
  }

  // The case session-smoke.mjs reported as `0 bytes of 76 sent`.
  const small = new TextEncoder().encode(
    JSON.stringify({ check: "forwarded-body", note: "a POST must arrive with its body" }).padEnd(
      76,
      " ",
    ),
  );

  setState("POST through the member edge");
  results.push(
    await bodyCase("POST 76 B, fetch() -> member edge -> libp2p", small, () =>
      fetch(viaEdge, { method: "POST", body: small, headers: { "content-type": "text/plain" } }),
    ),
  );

  setState("POST through the gateway");
  results.push(
    await bodyCase("POST 76 B, fetch() -> gateway -> member edge -> libp2p", small, () =>
      fetch(viaGateway, { method: "POST", body: small, headers: { "content-type": "text/plain" } }),
    ),
  );

  setState("large POST through the gateway");
  const large = randomBytes(1024 * 1024);
  results.push(
    await bodyCase("POST 1 MiB, fetch() -> gateway -> member edge -> libp2p", large, () =>
      fetch(viaGateway, {
        method: "POST",
        body: large,
        headers: { "content-type": "application/octet-stream" },
      }),
    ),
  );

  // A STREAMED body, handed to the gateway in-page: a Request built here, not
  // by the worker, so its body is a ReadableStream the forwarders must carry
  // as a stream (`bodyOf`'s other branch). An engine without request streams
  // (Firefox) cannot build such a Request at all, so the case is skipped
  // there -- the buffered cases above are the ones that engine needs.
  setState("streamed POST into the gateway");
  const streamedName = "POST 512 KiB as a ReadableStream -> gateway -> member edge -> libp2p";
  if (supportsRequestStreams()) {
    const chunks = Array.from({ length: 8 }, () => randomBytes(64 * 1024));
    const whole = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    for (const [i, chunk] of chunks.entries()) whole.set(chunk, i * chunk.byteLength);
    results.push(
      await bodyCase(streamedName, whole, () => {
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i < chunks.length) controller.enqueue(chunks[i++] as Uint8Array);
            else controller.close();
          },
        });
        return gateway(
          new Request(new URL(`/${GATEWAY_KEY}/${hub}/echo`, location.origin), {
            method: "POST",
            body,
            duplex: "half",
            headers: { "content-type": "application/octet-stream" },
          } as RequestInit),
        );
      }),
    );
  } else {
    results.push({
      name: streamedName,
      status: "skip",
      detail: "this engine cannot build a Request with a stream body",
    });
  }

  setState("done");
  w.__forwardedBody = { state: "done", results, hubLink: member.hubLink() };
}

run().catch((err) => {
  w.__forwardedBody = { state: "error", step, message: String((err as Error)?.stack ?? err) };
  const el = document.getElementById("state");
  if (el) el.textContent = `error: ${step}`;
});
